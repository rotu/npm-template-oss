const fs = require('fs/promises')
const { basename, extname, dirname, relative, join } = require('path')
const yaml = require('yaml')
const NpmPackageJson = require('@npmcli/package-json')
const jsonParse = require('json-parse-even-better-errors')
const Diff = require('diff')
const { unset, mergeWith } = require('lodash')
const ini = require('ini')
const template = require('./template.js')
const jsonDiff = require('./json-diff')

const merge = (...o) => mergeWith({}, ...o, (_, srcValue) => {
  if (Array.isArray(srcValue)) {
    // Dont merge arrays, last array wins
    return srcValue
  }
})

const setFirst = (first, rest) => ({ ...first, ...rest })

const traverse = (value, visit, keys = []) => {
  if (keys.length) {
    const res = visit(keys, value)
    if (res != null) {
      return
    }
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      traverse(v, visit, keys.concat(k))
    }
  }
}

const fsOk = (code) => (error) => {
  if (error.code === 'ENOENT') {
    return null
  }
  return Object.assign(error, { code })
}

const state = new Map()

class Base {
  static types = []
  static header = 'This file is automatically added by {{ __NAME__ }}. Do not edit.'
  static comment = (v) => v
  static clean = false
  static merge = false // supply a merge function which runs on prepare for certain types
  static DELETE = template.DELETE

  constructor (target, source, options) {
    this.target = target
    this.source = source
    this.options = options
    this.state.count++
  }

  get state () {
    if (!state.has(this.target)) {
      state.set(this.target, { count: 0 })
    }
    return state.get(this.target)
  }

  header () {
    if (typeof this.constructor.comment === 'function') {
      return this.constructor.comment(this.template(this.constructor.header || ''), this.options)
    }
  }

  clean () {
    if (this.state.count === 1 && this.constructor.clean) {
      return fs.rm(this.target).catch(fsOk())
    }
    return null
  }

  async read (s) {
    if (s === this.source) {
      // allow shadowing files in configured content directories
      // without needing to add the file to the config explicitly
      const dirs = this.options.config.__PARTIAL_DIRS__
      const relDir = dirs.find(d => s.startsWith(d))
      const relFile = relative(relDir, s)
      const lookupDirs = dirs.slice(0).reverse()
      for (const dir of lookupDirs) {
        const file = await fs.readFile(join(dir, relFile), { encoding: 'utf-8' }).catch(fsOk())
        if (file !== null) {
          return file
        }
      }
    }
    return fs.readFile(s, { encoding: 'utf-8' })
  }

  template (s) {
    return template(s, this.options)
  }

  parse (s) {
    return s
  }

  prepare (s) {
    const header = this.header()
    return header ? `${header}\n\n${s}` : s
  }

  prepareTarget (s) {
    return s
  }

  toString (s) {
    return s.toString()
  }

  async write (s) {
    // XXX: find more efficient way to do this. we can build all possible dirs before get here
    await fs.mkdir(dirname(this.target), { owner: 'inherit', recursive: true, force: true })
    return fs.writeFile(this.target, this.toString(s), { owner: 'inherit' })
  }

  diffPatch (t, s) {
    // create a patch and strip out the filename. if it ends up an empty string
    // then return true since the files are equal
    return Diff.createPatch('', t.replace(/\r\n/g, '\n'), s.replace(/\r\n/g, '\n'))
      .split('\n').slice(4).join('\n')
  }

  diff (t, s) {
    return this.diffPatch(t, s)
  }

  // the apply methods are the only ones that should be called publically
  // XXX: everything is allowed to be overridden in base classes but we could
  // find a different solution than making everything public
  applyWrite () {
    return Promise.resolve(this.clean())
      .then(() => this.read(this.source))
      // replace template vars first, this will throw for nonexistant vars
      // because it must be parseable after this step
      .then((s) => this.template(s))
      // parse into whatever data structure is necessary for maniuplating
      // diffing, merging, etc. by default its a string
      .then((s) => {
        this.sourcePreParse = s
        return this.parse(s)
      })
      // prepare the source for writing and diffing, pass in current
      // target for merging. errors parsing or preparing targets are ok here
      .then((s) => this.applyTarget().catch(() => null).then((t) => this.prepare(s, t)))
      .then((s) => this.write(s))
  }

  applyTarget () {
    return Promise.resolve(this.read(this.target))
      .then((s) => this.parse(s))
      // for only preparing the target for diffing
      .then((s) => this.prepareTarget(s))
  }

  async applyDiff () {
    // handle if old does not exist
    const targetError = 'ETARGETERROR'
    const target = await this.applyTarget().catch(fsOk(targetError))

    // no need to diff if current file does not exist
    if (target === null) {
      return null
    }

    const source = await Promise.resolve(this.read(this.source))
      .then((s) => this.template(s))
      .then((s) => this.parse(s))
      // gets the target to diff against in case it needs to merge, etc
      .then((s) => this.prepare(s, target))

    // if there was a target error then there is no need to diff
    // so we just show the source with an error message
    if (target.code === targetError) {
      const msg = `[${this.options.config.__NAME__} ERROR]`
      return [
        `${msg} There was an erroring getting the target file`,
        `${msg} ${target}`,
        `${msg} It will be overwritten with the following source:`,
        '-'.repeat(40),
        this.toString(source),
      ].join('\n')
    }

    // individual diff methods are responsible for returning a string
    // representing the diff. an empty trimmed string means no diff
    const diffRes = this.diff(target, source).trim()
    return diffRes || true
  }
}

class Gitignore extends Base {
  static types = ['codeowners', 'gitignore']
  static comment = (c) => `# ${c}`
}

class Js extends Base {
  static types = ['js']
  static comment = (c) => `/* ${c} */`
}

class Ini extends Base {
  static types = ['ini']
  static comment = (c) => `; ${c}`

  toString (s) {
    return typeof s === 'string' ? s : ini.stringify(s)
  }

  parse (s) {
    return typeof s === 'string' ? ini.parse(s) : s
  }

  prepare (s, t) {
    let source = s
    if (typeof this.constructor.merge === 'function' && t) {
      source = this.constructor.merge(t, s)
    }
    return super.prepare(this.toString(source))
  }

  diff (t, s) {
    return jsonDiff(this.parse(t), this.parse(s), this.constructor.DELETE)
  }
}

class IniMerge extends Ini {
  static types = ['npmrc']
  static merge = (t, s) => merge(t, s)
}

class Markdown extends Base {
  static types = ['md']
  static comment = (c) => `<!-- ${c} -->`
}

class Yml extends Base {
  static types = ['yml']
  static comment = (c) => ` ${c}`

  toString (s) {
    try {
      return s.toString({ lineWidth: 0, indent: 2 })
    } catch (err) {
      err.message = [this.target, this.sourcePreParse, ...s.errors, err.message].join('\n')
      throw err
    }
  }

  parse (s) {
    return yaml.parseDocument(s)
  }

  prepare (s) {
    s.commentBefore = this.header()
    return this.toString(s)
  }

  prepareTarget (s) {
    return this.toString(s)
  }
}

class YmlMerge extends Yml {
  prepare (source, t) {
    if (t === null) {
      // If target does not exist or is in an
      // error state, we cant do anything but write
      // the whole document
      return super.prepare(source)
    }

    const key = [].concat(this.constructor.key)

    const getId = (node) => {
      const index = node.items.findIndex(p => p.key?.value === this.constructor.id)
      return index !== -1 ? node.items[index].value?.value : node.toJSON()
    }

    const target = this.parse(t)
    const targetNodes = target.getIn(key).items.reduce((acc, node, index) => {
      acc[getId(node)] = { node, index }
      return acc
    }, {})

    for (const node of source.getIn(key).items) {
      const index = targetNodes[getId(node)]?.index
      if (typeof index === 'number' && index !== -1) {
        target.setIn([...key, index], node)
      } else {
        target.addIn(key, node)
      }
    }

    return super.prepare(target)
  }
}

class Json extends Base {
  static types = ['json']
  // its a json comment! not really but we do add a special key
  // to json objects
  static comment = (c, o) => ({ [`//${o.config.__NAME__}`]: c })

  toString (s) {
    return JSON.stringify(
      s,
      (_, v) => v === this.constructor.DELETE ? undefined : v,
      2
    ).trim() + '\n'
  }

  parse (s) {
    return jsonParse(s)
  }

  prepare (s, t) {
    let source = s
    if (typeof this.constructor.merge === 'function' && t) {
      source = this.constructor.merge(t, s)
    }
    return setFirst(this.header(), source)
  }

  diff (t, s) {
    return jsonDiff(t, s, this.constructor.DELETE)
  }
}

class JsonMerge extends Json {
  static header = 'This file is partially managed by {{ __NAME__ }}. Edits may be overwritten.'
  static merge = (t, s) => merge(t, s)
}

class PackageJson extends JsonMerge {
  static types = ['pkg.json']

  async prepare (s, t) {
    // merge new source with current pkg content
    const update = super.prepare(s, t)

    // move comment to config field
    const configKey = this.options.config.__CONFIG_KEY__
    const header = this.header()
    const headerKey = Object.keys(header)[0]
    update[configKey] = setFirst(header, update[configKey])
    delete update[headerKey]

    return update
  }

  async write (s) {
    const pkg = await NpmPackageJson.load(dirname(this.target))
    pkg.update(s)
    traverse(pkg.content, (keys, value) => {
      if (value === this.constructor.DELETE) {
        return unset(pkg.content, keys)
      }
    })
    await pkg.save()
  }
}

const Parsers = {
  Base,
  Gitignore,
  Js,
  Ini,
  IniMerge,
  Markdown,
  Yml,
  YmlMerge,
  Json,
  JsonMerge,
  PackageJson,
}

const parserLookup = Object.values(Parsers)

const getParser = (file) => {
  const base = basename(file).toLowerCase()
  const ext = extname(file).slice(1).toLowerCase()

  return parserLookup.find((p) => p.types.includes(base))
    || parserLookup.find((p) => p.types.includes(ext))
    || Parsers.Base
}

module.exports = getParser
module.exports.Parsers = Parsers