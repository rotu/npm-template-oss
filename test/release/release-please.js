const t = require('tap')
const nockFixtures = require('../fixtures/nock.js')

const mockReleasePlease = (t, { fixture, record, ...opts } = {}) => {
  const { token } = nockFixtures(t, { fixture, record })
  const releasePlease = t.mock('../../lib/release/release-please.js')
  // token,
  // repo,
  // dryRun,
  // branch,
  // forcePullRequest,
  // backport,
  // runId,
  // silent,
  return releasePlease.create({
    token,
    repo: 'npm/npm-cli-release-please',
    silent: true,
    ...opts,
  })
}

t.test('errors', async t => {
  const releasePlease = t.mock('../../lib/release/release-please.js')
  t.rejects(releasePlease.create())
  t.rejects(releasePlease.create({}))
  t.rejects(releasePlease.create({ token: 'ok' }))
  t.rejects(releasePlease.create({ token: 'ok', repo: 'ok', force: 'not a number' }))
})

t.test('create release pr', async t => {
  const res = await mockReleasePlease(t)
  t.matchSnapshot(res)
})

t.test('create releases', async t => {
  const res = await mockReleasePlease(t)
  t.matchSnapshot(res)
})

t.test('create releases backport', async t => {
  const res = await mockReleasePlease(t, {
    fixture: 'create releases',
    backport: true,
  })
  t.matchSnapshot(res)
})

t.test('force update pr', async t => {
  const res = await mockReleasePlease(t, {
    force: 134,
  })
  t.matchSnapshot(res)
})

// t.test('force get releases', async t => {
//   const res = await mockReleasePlease(t, {
//     force: 134,
//   })
//   t.matchSnapshot(res)
// })
