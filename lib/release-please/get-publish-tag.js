const semver = require('semver')

// When the CLI is auto published, this will have to account for tagging it
// `next-MAJOR` before publishing it as `latest`
module.exports = ({ backport, version }) => {
  const sVersion = semver.parse(version)

  if (backport) {
    return `latest-${sVersion.major}`
  }

  return sVersion.prerelease.length ? 'prerelease' : 'latest'
}
