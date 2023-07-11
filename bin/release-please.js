#!/usr/bin/env node

const core = require('@actions/core')
const ReleasePlease = require('../lib/release/release-please.js')

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

ReleasePlease.create({
  token: process.env.GITHUB_TOKEN,
  repo: process.env.GITHUB_REPOSITORY,
  runId: process.env.GITHUB_RUN_ID,
  branch: args.branch,
  backport: args.backport,
  force: args.force,
}).then(({ commentId, pr, release, releases }) => {
  if (commentId) {
    core.setOutput('comment-id', commentId)
  }

  if (pr) {
    core.setOutput('pr', JSON.stringify(pr))
    core.setOutput('pr-branch', pr.headBranchName)
    core.setOutput('pr-number', pr.number)
    core.setOutput('pr-sha', pr.sha)
  }

  if (release) {
    core.setOutput('release', JSON.stringify(release))
  }

  if (releases) {
    core.setOutput('releases', JSON.stringify(releases))
  }

  return null
}).catch(err => {
  core.setFailed(`failed: ${err}`)
})
