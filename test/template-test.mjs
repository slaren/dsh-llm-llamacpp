// Automated compatibility checks against the actual llama.cpp templates.
//
//   LLAMA_CPP_TEMPLATE_MODEL=/path/to/model.gguf node test/template-test.mjs
//
// Optional:
//   LLAMA_CPP_TEMPLATE_SERVER  llama-server binary
//   LLAMA_CPP_TEMPLATE_DIR     directory containing models/templates/*.jinja
//
// Each template gets its own short-lived server using --chat-template-file, then
// the suite applies representative message sequences through /apply-template.
// The assertions reflect llama.cpp's effective behavior, including its
// system-role workaround, not the raw Jinja source.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const serverBin = process.env.LLAMA_CPP_TEMPLATE_SERVER ?? join(homedir(), 'code/llama.cpp/build/bin/llama-server')
const model = process.env.LLAMA_CPP_TEMPLATE_MODEL
const templatesDir = process.env.LLAMA_CPP_TEMPLATE_DIR ?? join(homedir(), 'code/llama.cpp/models/templates')

if (model === undefined || model === '') {
  console.log('skip template tests: set LLAMA_CPP_TEMPLATE_MODEL to a model file')
  process.exit(0)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => resolve(port))
  })
})

async function start(template) {
  const port = await freePort()
  const proc = spawn(serverBin, [
    '-m', model,
    '--port', String(port),
    '--host', '127.0.0.1',
    '-c', '2048',
    '-np', '1',
    '--jinja',
    '--chat-template-file', join(templatesDir, template),
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (chunk) => { stderr += chunk })
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/props`)
      if (res.ok) return { proc, port }
    } catch { /* still loading */ }
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`server did not start for ${template}: ${stderr.slice(-500)}`)
}

async function apply(port, messages) {
  const res = await fetch(`http://127.0.0.1:${port}/apply-template`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, add_generation_prompt: true }),
  })
  return res.status
}

const cases = [
  { template: 'Qwen3.5-4B.jinja', allowsMidSystem: false },
  { template: 'Qwen-Qwen2.5-7B-Instruct.jinja', allowsMidSystem: true },
  { template: 'Mistral-Small-3.2-24B-Instruct-2506.jinja', allowsMidSystem: false },
  { template: 'mistralai-Mistral-Nemo-Instruct-2407.jinja', allowsMidSystem: false },
  { template: 'google-gemma-2-2b-it.jinja', allowsMidSystem: false },
]

for (const testCase of cases) {
  const { proc, port } = await start(testCase.template)
  try {
    const leading = await apply(port, [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
    ])
    const mid = await apply(port, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'ok' },
      { role: 'system', content: 'mid-history update' },
      { role: 'user', content: 'next' },
    ])
    const folded = await apply(port, [
      { role: 'user', content: 'system prompt\n\nhello' },
    ])
    check(`${testCase.template}: leading system is accepted by the server`, leading, 200)
    check(`${testCase.template}: raw mid-history system is ${testCase.allowsMidSystem ? 'accepted' : 'rejected'}`, testCase.allowsMidSystem ? mid === 200 : mid >= 400, true)
    check(`${testCase.template}: folded user turn is accepted`, folded, 200)
  } finally {
    proc.kill('SIGKILL')
    await sleep(150)
  }
}

console.log(failures === 0 ? '\nALL TEMPLATE CHECKS PASSED' : `\n${failures} TEMPLATE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
