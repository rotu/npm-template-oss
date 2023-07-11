const t = require('tap')
const nockFixtures = require('../fixtures/nock.js')

const mockReleasePlease = (t, { record, ...opts }) => {
  const { token } = nockFixtures(t, { record })
  const releaseManager = t.mock('../../lib/release-manager/index.js')
  // token,
  // repo,
  // prNumber,
  // commentId,
  // lockfile,
  // publish,
  // backport,
  // silent,
  return releaseManager.create({
    token,
    silent: true,
    ...opts,
  })
}

t.test('create with comment', async t => {
  const res = await mockReleasePlease(t, { repo: 'npm/npm-cli-release-please' })

  console.error(res)
})
