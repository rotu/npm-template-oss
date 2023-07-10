#!/usr/bin/env node

const core = require('@actions/core')
const main = require('../lib/release-please/index.js')

const dryRun = !process.env.CI
const args = process.argv.slice(2).reduce((acc, a) => {
  const [k, v = ''] = a.replace(/^--/, '').split('=')
  if (v === 'true') {
    acc[k] = true
  } else if (v === 'false') {
    acc[k] = false
  } else if (/^\d+$/.test(v)) {
    acc[k] = Number.parseInt(v.trim())
  } else if (v) {
    acc[k] = v.trim()
  }
  return acc
}, {})

const debugPr = (val) => {
  if (dryRun) {
    console.log('PR:', val.title.toString())
    console.log('='.repeat(40))
    console.log(val.body.toString())
    console.log('='.repeat(40))
    for (const update of val.updates.filter(u => u.updater.changelogEntry)) {
      console.log('CHANGELOG:', update.path)
      console.log('-'.repeat(40))
      console.log(update.updater.changelogEntry)
      console.log('-'.repeat(40))
    }
    for (const update of val.updates.filter(u => u.updater.rawContent)) {
      console.log('package:', update.path)
      console.log('-'.repeat(40))
      console.log(JSON.parse(update.updater.rawContent).name)
      console.log(JSON.parse(update.updater.rawContent).version)
      console.log('-'.repeat(40))
    }
  }
}

const debugRelease = (val) => {
  if (dryRun) {
    console.log('ROOT RELEASE:', JSON.stringify(val, null, 2))
  }
}

const debugReleases = (val) => {
  if (dryRun) {
    console.log('ALL RELEASES:', JSON.stringify(val, null, 2))
  }
}

main({
  token: process.env.GITHUB_TOKEN,
  repo: process.env.GITHUB_REPOSITORY,
  dryRun,
  branch: args.branch,
  backport: args.backport,
  forcePullRequest: args['force-pr'],
}).then(({ pr, release, releases }) => {
  if (pr) {
    debugPr(pr)
    core.setOutput('pr', JSON.stringify(pr))
    core.setOutput('pr-branch', pr.headBranchName)
    core.setOutput('pr-number', pr.number)
    core.setOutput('pr-sha', pr.sha)
  }

  if (release) {
    debugRelease(release)
    core.setOutput('release', JSON.stringify(release))
  }

  if (releases) {
    debugReleases(releases)
    core.setOutput('releases', JSON.stringify(releases))
  }

  return null
}).catch(err => {
  if (dryRun) {
    console.error(err)
  } else {
    core.setFailed(`failed: ${err}`)
  }
})
