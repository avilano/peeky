import babel from '@rollup/plugin-babel'
import typescript from '@rollup/plugin-typescript'
import { rollup } from 'rollup'
import fs from 'fs'
import { fs as memfs } from 'memfs'
import { ufs } from 'unionfs'
import { patchFs, patchRequire } from 'fs-monkey'
import sinon from 'sinon'
import must from 'must'
import { install as installSourceMap } from 'source-map-support'
import { dirname, join } from 'path'
import consola from 'consola'
import { workerEmit } from '@akryum/workerpool'
import shortid from 'shortid'

export interface RunTestFileOptions {
  entry: string
}

interface Context {
  options: RunTestFileOptions
  suites: TestSuite[]
}

export interface TestSuiteInfo {
  id: string
  title: string
  filePath: string
  tests: {
    id: string
    title: string
  }[]
}

export interface TestSuiteResult {
  id: string
  title: string
  filePath: string
  errors: number
  tests: {
    id: string
    title: string
    error: Error
  }[]
}

interface TestSuite {
  id: string
  title: string
  filePath: string
  beforeAllHandlers: (() => unknown)[]
  beforeEachHandlers: (() => unknown)[]
  afterAllHandlers: (() => unknown)[]
  afterEachHandlers: (() => unknown)[]
  tests: Test[]
  errors: number
}

interface Test {
  id: string
  title: string
  handler: () => unknown
  error: Error
}

async function build (ctx: Context) {
  const originalFs = { ...fs }
  // @ts-ignore
  ufs.use(originalFs).use(memfs)
  // Patch unionfs to write to memfs only
  Object.assign(ufs, {
    unwatchFile: originalFs.unwatchFile,
    mkdir: memfs.mkdir,
    mkdirSync: memfs.mkdirSync,
    write: memfs.write,
    writeFile: memfs.writeFile,
    writeFileSync: memfs.writeFileSync,
  })
  patchFs(ufs)
  patchRequire(ufs)

  const targetDir = dirname(ctx.options.entry)

  // Ensure target directory
  memfs.mkdirSync(targetDir, { recursive: true })

  try {
    workerEmit('test-file:building', {
      testFilePath: ctx.options.entry,
    })
    const time = Date.now()
    const bundle = await rollup({
      input: ctx.options.entry,
      plugins: [
        typescript({
          tsconfig: join(process.cwd(), 'tsconfig.json'),
          module: 'ESNext',
        }),
        babel({
          babelHelpers: 'bundled',
        }),
      ],
      external: [
        /node_modules/,
      ],
    })

    await bundle.write({
      dir: join(targetDir, '/__output'),
      entryFileNames: 'target.js',
      format: 'cjs',
      sourcemap: true,
    })

    await bundle.close()
    workerEmit('test-file:build-completed', {
      testFilePath: ctx.options.entry,
      duration: Date.now() - time,
    })
  } catch (e) {
    consola.error(`Test build failed: ${e.message}`)
    throw e
  }
}

function registerGlobals (ctx: Context, target: any) {
  target.expect = must
  target.sinon = sinon

  let currentSuite: TestSuite

  target.describe = (title: string, handler: () => unknown) => {
    currentSuite = {
      id: shortid(),
      title,
      filePath: ctx.options.entry,
      tests: [],
      beforeAllHandlers: [],
      beforeEachHandlers: [],
      afterAllHandlers: [],
      afterEachHandlers: [],
      errors: 0,
    }
    ctx.suites.push(currentSuite)
    handler()
  }

  target.it = target.test = (title: string, handler: () => unknown) => {
    currentSuite.tests.push({
      id: shortid(),
      title,
      handler,
      error: null,
    })
  }

  target.beforeAll = (handler: () => unknown) => {
    currentSuite.beforeAllHandlers.push(handler)
  }

  target.afterAll = (handler: () => unknown) => {
    currentSuite.afterAllHandlers.push(handler)
  }

  target.beforeEach = (handler: () => unknown) => {
    currentSuite.beforeEachHandlers.push(handler)
  }

  target.afterEach = (handler: () => unknown) => {
    currentSuite.afterEachHandlers.push(handler)
  }
}

async function runTests (ctx: Context) {
  for (const suite of ctx.suites) {
    workerEmit('suite:start', {
      suite: {
        id: suite.id,
        title: suite.title,
        filePath: suite.filePath,
        tests: suite.tests.map(t => ({
          id: t.id,
          title: t.title,
        })),
      } as TestSuiteInfo,
    })
    const suiteTime = Date.now()
    for (const handler of suite.beforeAllHandlers) {
      await handler()
    }

    for (const test of suite.tests) {
      sinon.restore()

      for (const handler of suite.beforeEachHandlers) {
        await handler()
      }

      const time = Date.now()
      workerEmit('test:start', {
        suite: {
          id: suite.id,
        },
        test: {
          id: test.id,
        },
      })
      try {
        await test.handler()
        workerEmit('test:success', {
          suite: {
            id: suite.id,
          },
          test: {
            id: test.id,
          },
          duration: Date.now() - time,
        })
      } catch (e) {
        test.error = e
        workerEmit('test:error', {
          suite: {
            id: suite.id,
          },
          test: {
            id: test.id,
          },
          duration: Date.now() - time,
          error: e,
          stack: e.stack.substr(0, e.stack.indexOf('at runTests')),
        })
        suite.errors++
      }

      for (const handler of suite.afterEachHandlers) {
        await handler()
      }
    }

    for (const handler of suite.afterAllHandlers) {
      await handler()
    }

    workerEmit('suite:completed', {
      suite: {
        id: suite.id,
        errors: suite.errors,
      },
      duration: Date.now() - suiteTime,
    })
  }
}

export async function runTestFile (options: RunTestFileOptions) {
  try {
    const ctx: Context = {
      options,
      suites: [],
    }
    await build(ctx)
    registerGlobals(ctx, global)
    installSourceMap()
    require(join(dirname(ctx.options.entry), '/__output/target.js'))
    await runTests(ctx)

    const suites: TestSuiteResult[] = ctx.suites.map(s => ({
      id: s.id,
      title: s.title,
      filePath: s.filePath,
      errors: s.errors,
      tests: s.tests.map(t => ({
        id: t.id,
        title: t.title,
        error: t.error,
      })),
    }))
    return {
      filePath: options.entry,
      suites,
    }
  } catch (e) {
    consola.error(`Running tests failed: ${e.stack}`)
    throw e
  }
}