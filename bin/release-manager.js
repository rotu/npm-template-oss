#!/usr/bin/env node

const ReleaseManager = require('../lib/release/release-manager.js')

ReleaseManager.create({
  // These env vars are set by the release.yml workflow from template-oss
  repo: process.env.GITHUB_REPOSITORY,
  token: process.env.GITHUB_TOKEN,
  prNumber: process.env.RELEASE_PR_NUMBER,
  commentId: process.env.RELEASE_COMMENT_ID,
  lockfile: process.argv.includes('--lockfile=true'),
  publish: process.argv.includes('--publish=true'),
  backport: process.argv.includes('--backport=true'),
})
  .then((res) => !res.comment && console.log(res.notes))
  // This is part of the release CI and is for posting a release manager
  // comment to the issue but we dont want it to ever fail the workflow so
  // just log but dont set the error code
  .catch(err => console.error(err))
