const RP = require('release-please')
const { CheckpointLogger } = require('release-please/build/src/util/logger.js')
const ChangelogNotes = require('./changelog.js')
const Version = require('./version.js')
const NodeWs = require('./node-workspace.js')
const getPublishTag = require('./get-publish-tag.js')
const util = require('./util.js')

const omit = (obj, ...keys) => {
  const res = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!keys.includes(key)) {
      res[key] = value
    }
  }
  return res
}

class ReleasePlease {
  #token
  #owner
  #repo
  #nwo
  #branch
  #force
  #backport
  #runId
  #logger

  #github
  #octokit
  #manifest

  constructor ({
    token,
    repo,
    branch,
    force,
    backport,
    runId,
    silent,
  }) {
    if (!token) {
      throw new Error('Token is required')
    }

    if (!repo) {
      throw new Error('Repo is required')
    }

    if (force && typeof force !== 'number') {
      throw new Error('force must be a number')
    }

    this.#token = token

    const nwo = repo.split('/')
    this.#owner = nwo[0]
    this.#repo = nwo[1]
    this.#nwo = { owner: this.#owner, repo: this.#repo }

    this.#branch = branch
    this.#force = force
    this.#backport = backport
    this.#runId = runId

    /* istanbul ignore next */
    this.#logger = silent ? {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    } : new CheckpointLogger(true, true)
  }

  static async create (opts) {
    const rp = new ReleasePlease(opts)
    await rp.init()
    return rp.create()
  }

  async init () {
    RP.setLogger(this.#logger)
    RP.registerChangelogNotes('default', (o) => new ChangelogNotes(o))
    RP.registerVersioningStrategy('default', (o) => new Version(o))
    RP.registerPlugin('node-workspace', (o) =>
      new NodeWs(o.github, o.targetBranch, o.repositoryConfig))

    this.#github = await RP.GitHub.create({
      ...this.#nwo,
      token: this.#token,
    })

    this.#octokit = this.#github.octokit

    if (!this.#branch) {
      this.#branch = this.#github.repository.defaultBranch
    }

    // This is mostly for testing and debugging. Use environs with the
    // format `RELEASE_PLEASE_<manfiestOverrideConfigName>` (eg
    // `RELEASE_PLEASE_lastReleaseSha=<SHA>`) to set one-off config items
    // for the release please run without needing to commit and push the config.
    /* istanbul ignore next */
    const manifestOverrides = Object.entries(process.env)
      .filter(([k, v]) => k.startsWith('RELEASE_PLEASE_') && v != null)
      .map(([k, v]) => [k.replace('RELEASE_PLEASE_', ''), v])

    this.#manifest = await RP.Manifest.fromManifest(
      this.#github,
      this.#branch,
      undefined,
      undefined,
      Object.fromEntries(manifestOverrides)
    )
  }

  async create () {
    const { pullRequests, releases: rawReleases } = await this.#getReleaseArtifacts()

    this.#logger.debug(`pull requests: ${pullRequests.length}`)
    this.#logger.debug(`releases: ${rawReleases.length}`)

    const { pr = null, commentId = null } = await this.#parsePullRequests(pullRequests)
    const { release = null, releases = null } = await this.#parseReleases(rawReleases)

    return {
      pr,
      commentId,
      release,
      releases,
    }
  }

  async #parseReleases (releases) {
    if (releases.length === 0) {
      return {}
    }

    const firstRelease = releases[0]

    this.#logger.debug(`looking for pr from sha: ${firstRelease.sha}`)

    // All releases are from the same PR so we only need to look this up once
    const releasePrNumber = await this.#octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      ...this.#nwo,
      commit_sha: firstRelease.sha,
      per_page: 1,
    }).then(r => r.data[0].number)

    this.#logger.debug(`found pr: ${releasePrNumber}`)

    let rootRelease = firstRelease
    for (const release of releases) {
      const { path } = release
      const prefix = path === '.' ? '' : path
      const isRoot = !prefix
      const packagePath = `${prefix}/package.json`

      this.#logger.debug(`release: ${JSON.stringify({
        ...omit(release, 'notes'),
        isRoot,
        prefix,
      }, null, 2)}`)

      const releasePkgName = await this.#octokit.rest.repos.getContent({
        ...this.#nwo,
        ref: this.#branch,
        path: packagePath,
      }).then(r => JSON.parse(Buffer.from(r.data.content, r.data.encoding)).name)

      this.#logger.debug(`pkg name from ${packagePath}#${this.#branch}: "${releasePkgName}"`)

      release.prNumber = releasePrNumber
      release.pkgName = releasePkgName
      release.publishTag = getPublishTag({ backport: this.#backport, version: release.version })
      release.isRoot = isRoot
      release.isWorkspace = !isRoot

      if (release.isRoot) {
        rootRelease = release
      }
    }

    return {
      release: rootRelease,
      releases,
    }
  }

  async #parsePullRequests (pullRequests) {
    if (pullRequests.length === 0) {
      return {}
    }

    // This does not currently happen, but it is supported by release please so
    // if it ever does this will be a nice error message instead of just blowing
    // up. Update this if we start creating individual PRs per workspace release
    /* istanbul ignore next */
    if (pullRequests.length > 1) {
      throw new Error(`got ${pullRequests.length} prs but expected 1`)
    }

    const [rootPr] = pullRequests

    this.#logger.debug(`root pr: ${JSON.stringify(omit(rootPr, 'body'), null, 2)}`)

    // this does not come with the release please release information, but we
    // need it elsewhere in our release workflow, so we grab the last sha from
    // the PR to run against
    rootPr.sha = await this.#octokit.paginate(this.#octokit.rest.pulls.listCommits, {
      ...this.#nwo,
      pull_number: rootPr.number,
    }).then((commits) => commits[commits.length - 1].sha)

    const body = ['## Release Manager']

    // If running inside a GitHub workflow, use the run id to get a nice url to link back to.
    // Ignored from coverage because it is difficult to mock.
    /* istanbul ignore next */
    if (this.#runId) {
      const { data: workflow } = await this.#octokit.rest.actions.getWorkflowRun({
        ...this.#nwo,
        run_id: this.#runId,
      })
      if (workflow?.html_url) {
        body.push(`Release workflow run: ${workflow.html_url}`)
      }
    }

    /* eslint-disable max-len */
    body.push(`#### Force CI to Update This Release`)
    body.push(`This PR will be updated and CI will run for every non-\`chore:\` commit that is pushed to \`${this.#branch}\`. ` +
      `To force CI to update this PR, run this command:`)
    body.push(util.codeBlock(`gh workflow run release.yml -r ${this.#branch} -R ${this.#owner}/${this.#repo} -f release-pr=${rootPr.number}`))
    /* eslint-enable max-len */

    let commentId = await this.#octokit.paginate(this.#octokit.rest.issues.listComments, {
      ...this.#nwo,
      issue_number: rootPr.number,
    }).then((cs) =>
      cs.find(c => c.user.login === 'github-actions[bot]' && c.body.startsWith(body[0]))?.id
    )

    if (commentId) {
      await this.#octokit.rest.issues.updateComment({
        ...this.#nwo,
        comment_id: commentId,
        body,
      })
    } else {
      const { data: comment } = await this.#octokit.rest.issues.createComment({
        ...this.#nwo,
        issue_number: rootPr.number,
        body: body.join('\n\n').trim(),
      })
      if (comment?.id) {
        commentId = comment.id
      }
    }

    return {
      pr: rootPr,
      commentId,
    }
  }

  async #getReleasesFromPr (number) {
    const releases = []

    // get the release please formatted pull request
    let pullRequest
    for await (const pr of this.#github.pullRequestIterator(this.#branch, 'MERGED', 200, false)) {
      if (pr.number === number) {
        pullRequest = pr
        break
      }
    }

    const strategiesByPath = await this.#manifest.getStrategiesByPath()
    for (const path in this.#manifest.repositoryConfig) {
      const config = this.#manifest.repositoryConfig[path]
      const release = await strategiesByPath[path].buildRelease(pullRequest)
      if (release) {
        const { tag, ...rest } = release
        releases.push({
          ...rest,
          ...tag.version,
          tagName: tag.toString(),
          version: tag.version.toString(),
          path,
          draft: false,
          url: `https://github.com/${this.#owner}/${this.#repo}/releases/tag/${tag.toString()}`,
          prerelease: config.prerelease && !!tag.version.preRelease,
        })
      }
    }

    return releases
  }

  async #forceReleaseArtifacts (prNumber) {
    const { data: releasePr } = await this.#octokit.rest.pulls.get({
      ...this.#nwo,
      pull_number: prNumber,
    })

    /* istanbul ignore next */
    if (!releasePr) {
      throw new Error(`Could not find PR from number: ${prNumber}`)
    }

    if (releasePr.state === 'open') {
      // touch the pull request so it will get recreated by release please
      // we return nothing here so that the prs will get fetched in the next step

      // XXX(hack): to get release please to recreate a pull request it needs
      // to have a different body string so we append a message a message that CI
      // is running. This will force release-please to rebase the PR but it
      // wont update the body again, so we only append to it.
      /* istanbul ignore next */
      const id = this.#runId
        ? `by https://github.com/${this.#owner}/${this.#repo}/actions/runs/${this.#runId}`
        : `manually starting at ${new Date().toJSON()}`

      await this.#octokit.pulls.update({
        ...this.#nwo,
        pull_number: releasePr.number,
        body: `${releasePr.body.trim()}\n- This PR is being recreated ${id}`,
      })

      return
    }

    if (releasePr.state === 'closed' && releasePr.merged) {
      // this will get the releases which were created after a PR is merged to main
      // this is used in case some portion of the release process fails but we cant
      // rerun it since the commit was already pushed to main. this returns those
      // releases so they can be processed again by the rest of the release.yml workflow
      // we return the
      return {
        pullRequests: [],
        releases: await this.#getReleasesFromPr(releasePr.number),
      }
    }

    /* istanbul ignore next */
    throw new Error(`Could not run workflow on PR with wrong state: ${JSON.stringify(
      releasePr,
      null,
      2
    )}`)
  }

  async #getReleaseArtifacts () {
    const forcedArtifacts = this.#force
      ? await this.#forceReleaseArtifacts(this.#force)
      : null

    if (forcedArtifacts) {
      return forcedArtifacts
    }

    const pullRequests = await this.#manifest.createPullRequests()
    const releases = await this.#manifest.createReleases()

    return {
      pullRequests: pullRequests.filter(Boolean),
      releases: releases.filter(Boolean),
    }
  }
}

module.exports = ReleasePlease
