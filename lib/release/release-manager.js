const { Octokit } = require('@octokit/rest')
const semver = require('semver')
const mapWorkspaces = require('@npmcli/map-workspaces')
const { join } = require('path')
const getPublishTag = require('../lib/release-please/get-publish-tag.js')

class ReleaseManager {
  #ROOT
  #pkg
  #github
  #nwo
  #owner
  #repo
  #prNumber
  #commentId

  #lockfile
  #publish
  #backport

  #log

  constructor ({
    repo,
    token,
    prNumber,
    commentId,
    lockfile,
    publish,
    backport,
    silent,
  }) {
    if (!token || !repo || !prNumber) {
      throw new Error('`token`, `repo`, and `prNumber` are required')
    }

    this.#ROOT = process.cwd()
    this.#pkg = require(join(this.#ROOT, 'package.json'))
    this.#log = silent ? () => {} : (...a) => console.error('LOG', ...a)

    this.#nwo = repo.split('/')
    this.#owner = this.#nwo[0]
    this.#repo = this.#nwo[1]

    this.#github = new Octokit({ auth: token })
    this.#prNumber = prNumber
    this.#commentId = commentId

    this.#lockfile = lockfile
    this.#publish = publish
    this.#backport = backport
  }

  static create (opts) {
    const manager = new ReleaseManager(opts)
    return manager.create()
  }

  get #MANUAL_PUBLISH_STEPS () {
    return `
1. Checkout the release branch and test

    \`\`\`sh
    gh pr checkout <PR-NUMBER> --force
    npm ${this.#lockfile ? 'ci' : 'update'}
    npm test
    gh pr checks <PR-NUMBER> -R {NWO} --watch
    \`\`\`

1. Publish workspaces

    \`\`\`sh
    npm publish -w <WS-PKG-N>
    \`\`\`

1. Publish

    \`\`\`sh
    npm publish <PUBLISH-FLAGS>
    \`\`\`

1. Merge release PR

    \`\`\`sh
    gh pr merge <PR-NUMBER> -R {NWO} --rebase
    git checkout <BASE-BRANCH>
    git fetch
    git reset --hard origin/<BASE-BRANCH>
    \`\`\`
`
  }

  get #AUTO_PUBLISH_STEPS () {
    return `
1. Merge release PR :rotating_light: Merging this will auto publish :rotating_light:

    \`\`\`sh
    gh pr merge <PR-NUMBER> -R {NWO} --rebase
    \`\`\`
`
  }

  get #DEFAULT_RELEASE_PROCESS () {
    /* eslint-disable max-len */
    return (this.#publish ? this.#AUTO_PUBLISH_STEPS : this.#MANUAL_PUBLISH_STEPS) + `
1. Check For Release Tags

    Release Please will run on the just pushed release commit and create GitHub releases and tags for each package.

    \`\`\`
    gh run watch -R {NWO} $(gh run list -R {NWO} -w release -b <BASE-BRANCH> -L 1 --json databaseId -q ".[0].databaseId")
    \`\`\`
`
    /* eslint-enable max-len */
  }

  async #getReleaseProcess () {
    const RELEASE_LIST_ITEM = /^\d+\.\s/gm

    this.#log(`Fetching release process from:`, this.#owner, this.#repo, 'wiki')

    let releaseProcess = ''
    try {
      releaseProcess = await new Promise((resolve, reject) => {
        require('https')
          /* eslint-disable-next-line max-len */
          .get(`https://raw.githubusercontent.com/wiki/${this.#owner}/${this.#repo}/Release-Process.md`, resp => {
            let d = ''
            resp.on('data', c => (d += c))
            resp.on('end', () => {
              if (resp.statusCode !== 200) {
                reject(new Error(`${resp.req.protocol + resp.req.host + resp.req.path}: ${d}`))
              } else {
                resolve(d)
              }
            })
          })
          .on('error', reject)
      })
    } catch (e) {
      this.#log('Release wiki not found', e.message)
      this.#log('Using default release process')
      releaseProcess = this.#DEFAULT_RELEASE_PROCESS
        .replace(/\{NWO\}/g, `${this.#owner}/${this.#repo}`).trim() + '\n'
    }

    // XXX: the release steps need to always be the last thing in the doc for this to work
    const releaseLines = releaseProcess.split('\n')
    const releaseStartLine = releaseLines.reduce((acc, line, index) =>
      line.match(/^#+\s/) ? index : acc, 0)
    const section = releaseLines.slice(releaseStartLine).join('\n')

    return section.split({
      [Symbol.split] (str) {
        const [, ...matches] = str.split(RELEASE_LIST_ITEM)
        this.#log(`Found ${matches.length} release items`)
        return matches.map((m) => `- [ ] <STEP_INDEX>. ${m}`.trim())
      },
    })
  }

  async #getPrReleases (pr) {
    const RELEASE_SEPARATOR = /<details><summary>.*<\/summary>/g
    const MONO_VERSIONS = /<details><summary>(?:(.*?):\s)?(.*?)<\/summary>/
    const ROOT_VERSION = /\n##\s\[(.*?)\]/

    const workspaces = [...await mapWorkspaces({ pkg: this.#pkg, cwd: this.#ROOT })]
      .reduce((acc, [k]) => {
        const wsComponentName = k.startsWith('@') ? k.split('/')[1] : k
        acc[wsComponentName] = k
        return acc
      }, {})

    const getReleaseInfo = ({ name, version: rawVersion }) => {
      const version = semver.parse(rawVersion)
      const prerelease = !!version.prerelease.length
      const tag = `${name ? `${name}-` : ''}v${rawVersion}`
      const workspace = workspaces[name]
      const publishTag = getPublishTag({ backport: this.#backport, version: rawVersion })

      return {
        name,
        tag,
        prerelease,
        version: rawVersion,
        major: version.major,
        url: `https://github.com/${pr.base.repo.full_name}/releases/tag/${tag}`,
        flags: `${name ? `-w ${workspace}` : ''} --tag ${publishTag}`.trim(),
      }
    }

    const releases = pr.body.match(RELEASE_SEPARATOR)

    if (!releases) {
      this.#log('Found no monorepo, checking for single root version')
      const [, version] = pr.body.match(ROOT_VERSION) || []

      if (!version) {
        throw new Error('Could not find version with:', ROOT_VERSION)
      }

      this.#log('Found version', version)
      return [getReleaseInfo({ version })]
    }

    this.#log(`Found ${releases.length} releases`)

    return releases.reduce((acc, r) => {
      const [, name, version] = r.match(MONO_VERSIONS)
      const release = getReleaseInfo({ name, version })

      if (!name) {
        this.#log('Found root', release)
        acc[0] = release
      } else {
        this.#log('Found workspace', release)
        acc[1].push(release)
      }

      return acc
    }, [null, []])
  }

  async #appendToComment ({ title, body }) {
    if (!this.#commentId) {
      this.#log(`No comment id, skipping append to comment`)
      return null
    }

    const { data: comment } = await this.#github.rest.issues.getComment({
      ...this.#nwo,
      comment_id: this.#commentId,
    })

    const hasAppended = comment.body.includes(title)

    this.#log('Found comment with id:', this.#commentId)
    this.#log(hasAppended ? 'Comment has aready been appended, replacing' : 'Appending to comment')

    const prefix = hasAppended
      ? comment.body.split(title)[0]
      : comment.body

    return this.#github.rest.issues.updateComment({
      ...this.#nwo,
      comment_id: this.#commentId,
      body: [prefix, title, body].join('\n\n'),
    })
  }

  async create () {
    const { data: pr } = await this.#github.rest.pulls.get({
      ...this.#nwo,
      pull_number: this.#prNumber,
    })

    const [release, workspaces = []] = await this.#getPrReleases(pr)

    const RELEASE_OMIT_PRERELEASE = '> NOT FOR PRERELEASE'
    const RELEASE_OMIT_WORKSPACES = 'Publish workspaces'
    const releaseItems = (await this.#getReleaseProcess(this.#nwo))
      .filter((item) => {
        if (release.prerelease && item.includes(RELEASE_OMIT_PRERELEASE)) {
          return false
        }

        if (!workspaces.length && item.includes(RELEASE_OMIT_WORKSPACES)) {
          return false
        }

        return true
      })
      .map((item, index) => item.replace('<STEP_INDEX>', index + 1))

    this.#log(
      `Filtered ${releaseItems.length} release process items:\n`,
      releaseItems.map(r => r.split('\n')[0].replace('- [ ] ', '')).join(', ')
    )

    const releaseTitle = `### Release Checklist for ${release.tag}`
    const releaseChecklist = releaseItems
      .join('\n\n')
      .replace(/<PR-NUMBER>/g, this.#prNumber)
      .replace(/<RELEASE-BRANCH>/g, pr.head.ref)
      .replace(/<BASE-BRANCH>/g, pr.base.ref)
      .replace(/<MAJOR>/g, release.major)
      .replace(/<X\.Y\.Z>/g, release.version)
      .replace(/<GITHUB-RELEASE-LINK>/g, release.url)
      .replace(/<PUBLISH-FLAGS>/g, release.flags)
      .replace(/^(\s*\S.*)(-w <WS-PKG-N>)$/gm, workspaces.map(w => `$1${w.flags}`).join('\n'))
      .trim()

    const comment = await this.#appendToComment({
      title: releaseTitle,
      body: releaseChecklist,
    })

    return {
      comment,
      notes: releaseChecklist,
    }
  }
}

module.exports = ReleaseManager
