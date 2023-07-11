const nock = require('nock')
const zlib = require('zlib')
const { resolve, relative, dirname, sep } = require('path')
const fs = require('fs')

const DIR = __dirname
const CWD = process.cwd()
const RECORD = 'TEMPLATEOSS_NOCK_RECORD' in process.env ? true : undefined

const util = {
  decode: (v) => zlib.gzipSync(Buffer.from(JSON.stringify(v), 'utf-8')).toString('hex'),
  encode: (v) => JSON.parse(zlib.gunzipSync(Buffer.from(v.join(''), 'hex')).toString('utf-8')),
  getPath: (t, name) => {
    let fixtureName = relative(CWD, t.testdirName).split(`${sep}tap-testdir-`)[1]
    if (name) {
      const tapRe = /[^a-zA-Z0-9._-]+/ig
      fixtureName = fixtureName.replace(t.name.replace(tapRe, '-'), name.replace(tapRe, '-'))
    }
    return resolve(DIR, 'nock', `${fixtureName}.json`)
  },
}

module.exports = (t, { fixture, record: _rec = RECORD, decode = false } = {}) => {
  const fixturePath = util.getPath(t, fixture)
  const record = typeof _rec === 'boolean' ? _rec : !fs.existsSync(fixturePath)

  let token
  if (record) {
    token = process.env.GITHUB_TOKEN
    if (!token) {
      t.fail('process.env.GITHUB_TOKEN must be set to record tests')
    }
    if (process.env.CI) {
      t.fail('cannot record fixtures in CI, only locally')
    }
  } else {
    token = 'mock_token'
  }

  if (record) {
    fs.mkdirSync(dirname(fixturePath), { recursive: true })
    fs.rmSync(fixturePath, { force: true })
    nock.recorder.rec({ output_objects: true, dont_print: true })
  } else {
    const responses = nock.loadDefs(fixturePath).map((r) => {
      // if (decode) {
      //   r.response = util.decode(r.response)
      // }

      const bodyDate = /manually starting at ([\d-T:.Z]+)/
      if (r.method === 'PATCH' && bodyDate.test(r.body.body)) {
        r.filteringRequestBody = (body, aRecordedBody) => {
          const [, recordedDate] = aRecordedBody.body.match(bodyDate)
          return body.replace(bodyDate, `manually starting at ${recordedDate}`)
        }
      }

      return r
    })
    nock.define(responses)
    nock.disableNetConnect()
  }

  t.teardown(() => {
    if (record) {
      const responses = nock.recorder.play().map((r) => {
        if (decode) {
          r.response = util.encode(r.response)
        }
        return r
      })
      fs.writeFileSync(fixturePath, JSON.stringify(responses, null, 2), 'utf-8')
    } else {
      nock.enableNetConnect()
    }
  })

  return { token }
}
