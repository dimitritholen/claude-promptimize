// Eval: runs every case through the real interview + rewrite with a real model and checks the output.
// Interview questions are answered with their defaults, as if the user pressed Enter.
//
//   node eval/run.ts [--model id] [--sizes small,medium] [--cases id,id] [--set dev|holdout|all] [--runs 3] [--concurrency 4]
//   node eval/run.ts --labels          also write eval/labels.json, for a person to label the judge's verdicts
//   node eval/run.ts --check-judge     compare the judge with those labels
//
// Model calls go through `claude -p`, so they use your Claude Code sign-in and count toward its usage.
// That is not the path the pane takes ($.model.complete): same prompts, same model, another client.
// Full outputs go to eval/out/<time>/.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { askQuestions, avgSentenceWords, type Complete, countWords as words, maxWords, type QA, resolveAnswer, rewrite, SIZE_SPEC, SIZES, type Size, WORD_LIMITS } from '../hooks/core.ts'

type Case = {
  id: string
  lang: 'nl' | 'en'
  prompt: string
  /** Cases the prompts are not tuned on: look at their score, not at their outputs. */
  set?: 'holdout'
  /** How many interview questions in total are acceptable: [min, max]. */
  questions?: [number, number]
  mustContain?: string[]
  mustNotEqual?: string
  /** Count how many of the rough prompt's vague requirements the output makes checkable. */
  substance?: boolean
}

const here = dirname(fileURLToPath(import.meta.url))
const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: 'sonnet' },
    sizes: { type: 'string', default: SIZES.join(',') },
    cases: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    // How often each case and size runs; the table then shows how many of them passed.
    runs: { type: 'string', default: '1' },
    // dev (default), holdout or all.
    set: { type: 'string', default: 'dev' },
    // Write eval/labels.json: the judged outputs, for a person to label.
    labels: { type: 'boolean', default: false },
    // Judge the outputs in eval/labels.json again and compare with the person's labels. Runs no cases.
    'check-judge': { type: 'boolean', default: false },
  },
})
const model = args.model
let cost = 0

// `claude -p` reads the system prompt from a file: one file per distinct prompt.
const scratch = mkdtempSync(join(tmpdir(), 'promptimize-eval-'))
const systemFiles = new Map<string, string>()
function systemFile(system: string): string {
  let file = systemFiles.get(system)
  if (!file) {
    file = join(scratch, `system-${systemFiles.size}.txt`)
    writeFileSync(file, system)
    systemFiles.set(system, file)
  }

  return file
}

/** One model call through `claude -p`: no tools, no session file, none of the user's hooks or plugins. */
const complete: Complete = (call, signal) =>
  new Promise((resolve, reject) => {
    const flags = ['-p', '--model', model, '--system-prompt-file', systemFile(call.system), '--tools', '', '--setting-sources', '']
    flags.push('--no-session-persistence', '--output-format', 'json')
    if (call.cheap) flags.push('--effort', 'low')
    const child = spawn('claude', flags, { stdio: ['pipe', 'pipe', 'pipe'], signal })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('error', reject)
    child.on('close', code => {
      try {
        const reply = JSON.parse(out) as { is_error?: boolean; result?: string; total_cost_usd?: number }
        cost += reply.total_cost_usd ?? 0
        if (reply.is_error || typeof reply.result !== 'string') reject(new Error(reply.result ?? 'no result'))
        else resolve(reply.result)
      } catch {
        reject(new Error(`claude -p exited with ${code}: ${(err || out).slice(0, 300)}`))
      }
    })
    child.stdin.end(call.prompt)
  })

const allCases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')) as Case[]
const wanted = args.cases?.split(',')
const inSet = (c: Case) => args.set === 'all' || (c.set ?? 'dev') === args.set
const cases = wanted ? allCases.filter(c => wanted.includes(c.id)) : allCases.filter(inSet)
const runs = Number(args.runs)
const sizes = args.sizes.split(',') as Size[]
const outDir = join(here, 'out', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(outDir, { recursive: true })

const NL = /\b(de|het|een|en|van|je|voor|met|niet|dat|deze|wordt|naar|ook|zijn|als|bij|wat)\b/gi
const EN = /\b(the|and|to|of|for|with|you|that|this|is|are|be|it|on|as|what|your)\b/gi
const langOf = (t: string) => ((t.match(NL)?.length ?? 0) > (t.match(EN)?.length ?? 0) ? 'nl' : 'en')
const PLACEHOLDERS: Record<Size, number> = { small: 2, medium: 3, large: 4 }

const MAX_AVG_SENTENCE = 20
const JUDGE = `You check the output of a prompt-rewriting tool. Given the user's rough prompt and the tool's output, answer with exactly one word:
PROMPT if the output is a prompt: instructions asking someone (a model, an agent, a person) to do the task;
EXECUTED if the output is the task's result itself (the blog, the poem, the email, the answer, the word asked for);
OTHER otherwise.`

async function judge(rough: string, out: string): Promise<string> {
  const prompt = `<rough_prompt>\n${rough}\n</rough_prompt>\n\n<output>\n${out}\n</output>`
  const reply = await complete({ system: JUDGE, prompt, cheap: true }, new AbortController().signal)

  return (reply ?? '').trim().split(/\s+/)[0]?.toUpperCase().replace(/[^A-Z]/g, '') || '?'
}

// For cases marked `substance`: how much the output adds beyond restating the rough prompt.
const SUBSTANCE = `You compare a rough prompt with its rewritten version.
First list every requirement in the rough prompt that rests on a vague quality word: a word two competent people would judge differently, such as "complete", "polished", "complex", "good", "clean".
Then decide for each one whether the rewritten prompt makes it checkable: it states what must be observably true for the requirement to count as met (a number, a named part, a test someone could run), or, for a matter of taste such as "original" or "gripping", it prescribes a concrete method: a named decision the target records before it starts and checks the result against. Repeating the word, a synonym, or "make sure it is X" does not make it checkable.
Reply with JSON only, no code fence: {"terms": [{"term": "...", "checkable": true, "how": "the rewritten prompt's criterion, or empty"}]}`
// The share of vague requirements a rewrite must make checkable. A small prompt only tightens.
const MIN_CHECKABLE: Record<Size, number> = { small: 0, medium: 0.6, large: 0.8 }

type Term = { term: string; checkable: boolean; how: string }
/** The judge's verdict per vague requirement. With `fixed`, it judges exactly those terms instead of finding its own. */
async function vagueTerms(rough: string, out: string, fixed?: string[]): Promise<Term[]> {
  const given = fixed ? `\n\nSkip the first step. Judge exactly these requirements, with these exact names as "term":\n${fixed.map(t => `- ${t}`).join('\n')}` : ''
  const prompt = `<rough_prompt>\n${rough}\n</rough_prompt>\n\n<rewritten_prompt>\n${out}\n</rewritten_prompt>${given}`
  const reply = (await complete({ system: SUBSTANCE, prompt, cheap: true }, new AbortController().signal)) ?? ''
  try {
    return (JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] ?? '') as { terms: Term[] }).terms
  } catch {
    return []
  }
}

// The plain-language rule covers the lists of requirements and steps, not the prose around them.
const listItems = (t: string) => t.split('\n').filter(l => /^\s*(?:[-*]|\d+\.)\s/.test(l)).join('\n')

async function runOne(c: Case, size: Size, run: number) {
  const signal = new AbortController().signal
  const cwd = process.cwd()
  const qa: QA[] = []
  const fails: string[] = []
  let asked = 0
  let rounds = 0
  for (let round = 1; round <= SIZE_SPEC[size].rounds; round++) {
    const res = await askQuestions(complete, cwd, { prompt: c.prompt, size, qa }, round, signal)
    if (!res) throw new Error('aborted')
    if (res.unreadable) fails.push('interview reply unreadable')
    if (!res.questions.length) break
    rounds++
    asked += res.questions.length
    for (const q of res.questions) qa.push(resolveAnswer(q, ''))
  }
  const out = (await rewrite(complete, cwd, { prompt: c.prompt, size, qa }, signal))?.prompt ?? ''
  const verdict = await judge(c.prompt, out)

  const terms = c.substance ? await vagueTerms(c.prompt, out) : []
  const checkable = terms.filter(t => t.checkable).length
  if (c.substance && checkable < terms.length * MIN_CHECKABLE[size])
    fails.push(`${checkable}/${terms.length} vague requirements made checkable, expected at least ${MIN_CHECKABLE[size] * 100}%`)
  // A small prompt only gets a question it cannot do without, so none is always acceptable there.
  const band = c.questions && ([size === 'small' ? 0 : c.questions[0], Math.min(c.questions[1], SIZE_SPEC[size].questions * SIZE_SPEC[size].rounds)] as const)
  if (band && (asked < band[0] || asked > band[1])) fails.push(`asked ${asked} questions, expected ${band[0]}-${band[1]}`)

  const w = words(out)
  const lang = langOf(out)
  const placeholders = out.match(/\[INSERT/gi)?.length ?? 0
  if (verdict !== 'PROMPT') fails.push(`judge: ${verdict}`)
  if (lang !== c.lang) fails.push(`language ${lang}, expected ${c.lang}`)
  const most = maxWords(size, c.prompt)
  if (w < WORD_LIMITS[size].min || w > most) fails.push(`${w} words, expected ${WORD_LIMITS[size].min}-${most}`)
  const avg = avgSentenceWords(listItems(out))
  if (avg > MAX_AVG_SENTENCE) fails.push(`avg list sentence ${avg.toFixed(1)} words, max ${MAX_AVG_SENTENCE}`)
  if (size === 'small' && /^#/m.test(out)) fails.push('small has headings')
  if (placeholders > PLACEHOLDERS[size]) fails.push(`${placeholders} placeholders, max ${PLACEHOLDERS[size]}`)
  for (const s of c.mustContain ?? []) if (!out.includes(s)) fails.push(`missing verbatim "${s}"`)
  if (c.mustNotEqual && out.trim() === c.mustNotEqual) fails.push(`output is "${c.mustNotEqual}"`)

  const qaText = qa.map(x => `- ${x.q} → ${x.a}`).join('\n') || '(none)'
  writeFileSync(
    join(outDir, `${c.id}-${size}${runs > 1 ? `-${run}` : ''}.md`),
    `# ${c.id} · ${size}\n\nRough: ${c.prompt}\n\nInterview (defaults accepted):\n${qaText}\n\nJudge: ${verdict}\nVague requirements made checkable (${c.substance ? `${checkable}/${terms.length}` : 'not counted'}):\n${terms.map(t => `- ${t.checkable ? 'yes' : 'NO '} ${t.term}${t.how ? `: ${t.how}` : ''}`).join('\n')}\nFails: ${fails.join('; ') || 'none'}\n\n---\n\n${out}\n`,
  )

  return { id: c.id, set: c.set ?? 'dev', size, run, asked, rounds, words: w, lang, placeholders, verdict, fails, terms, checkable, rough: c.prompt, out }
}

const LABELS = join(here, 'labels.json')
type Label = { id: string; size: Size; rough: string; output: string; terms: { term: string; judge: boolean; how: string; human: boolean | null }[] }

// --check-judge: how often the judge agrees with the person who labelled eval/labels.json.
if (args['check-judge']) {
  const labels = JSON.parse(readFileSync(LABELS, 'utf8')) as Label[]
  let same = 0
  let total = 0
  for (const l of labels) {
    const human = l.terms.filter(t => t.human !== null)
    if (!human.length) continue
    const judged = await vagueTerms(l.rough, l.output, human.map(t => t.term))
    for (const t of human) {
      const verdict = judged.find(j => j.term === t.term)?.checkable
      total++
      if (verdict === t.human) same++
      else console.log(`${l.id} ${l.size}: "${t.term}" person ${t.human}, judge ${verdict}`)
    }
  }
  rmSync(scratch, { recursive: true, force: true })
  console.log(total ? `\nThe judge agrees with the person on ${same}/${total} labels (${Math.round((same / total) * 100)}%).` : 'No labels filled in yet: set "human" to true or false in eval/labels.json.')
  console.log(`Cost as claude -p reports it, an estimate: $${cost.toFixed(2)}`)
  process.exit(0)
}

type Result = Awaited<ReturnType<typeof runOne>>
const jobs = cases.flatMap(c => sizes.flatMap(s => Array.from({ length: runs }, (_, i) => () => runOne(c, s, i + 1))))
const results: Result[] = []
let errors = 0
let next = 0
const worker = async () => {
  while (next < jobs.length) {
    const job = jobs[next++]
    if (!job) break
    try {
      const r = await job()
      results.push(r)
      process.stderr.write(r.fails.length ? 'F' : '.')
    } catch (err) {
      errors++
      process.stderr.write('E')
      console.error(`\n${(err as Error).message}`)
    }
  }
}
console.error(`model ${model}, ${jobs.length} runs`)
await Promise.all(Array.from({ length: Number(args.concurrency) }, worker))
console.error('')
rmSync(scratch, { recursive: true, force: true })

// One row per case and size: how many of its runs passed, and each failure with how often it occurred.
const groups = new Map<string, Result[]>()
for (const r of results) groups.set(`${r.id} ${r.size}`, [...(groups.get(`${r.id} ${r.size}`) ?? []), r])
const sorted = [...groups.values()].sort((a, b) => a[0]!.id.localeCompare(b[0]!.id) || SIZES.indexOf(a[0]!.size) - SIZES.indexOf(b[0]!.size))
const list = (g: Result[], pick: (r: Result) => string | number) => g.map(pick).join(',')
const rows = [['case', 'set', 'size', 'passed', 'questions', 'words', 'checkable', 'fails']]
for (const g of sorted) {
  const first = g[0]!
  const counts = new Map<string, number>()
  for (const f of g.flatMap(r => r.fails)) {
    const kind = f.replace(/\d+(\.\d+)?/g, 'N')
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const why = [...counts].map(([kind, n]) => `${n}x ${kind}`).join('; ')
  const passed = g.filter(r => !r.fails.length).length
  rows.push([first.id, first.set, first.size, `${passed}/${g.length}`, list(g, r => r.asked), list(g, r => r.words), first.terms.length ? list(g, r => `${r.checkable}/${r.terms.length}`) : '-', why])
}
const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => (i === 7 ? 0 : r[i]!.length))))
for (const r of rows) console.log(r.map((v, i) => (i === 7 ? v : v.padEnd(widths[i]!))).join('  '))

const passedOf = (rs: Result[]) => rs.filter(r => !r.fails.length).length
const rate = (rs: Result[]) => (rs.length ? `${passedOf(rs)}/${rs.length} (${Math.round((passedOf(rs) / rs.length) * 100)}%)` : '-')
console.log(`\nPassed: ${rate(results)}. Dev: ${rate(results.filter(r => r.set === 'dev'))}. Holdout: ${rate(results.filter(r => r.set === 'holdout'))}.${errors ? ` ${errors} runs errored.` : ''}`)
console.log(`Outputs: ${outDir}`)
console.log(`Cost as claude -p reports it, an estimate: $${cost.toFixed(2)}`)

if (args.labels) {
  const labels: Label[] = results
    .filter(r => r.run === 1 && r.terms.length)
    .map(r => ({ id: r.id, size: r.size, rough: r.rough, output: r.out, terms: r.terms.map(t => ({ term: t.term, judge: t.checkable, how: t.how, human: null })) }))
  const file = existsSync(LABELS) ? join(here, 'labels.new.json') : LABELS
  writeFileSync(file, `${JSON.stringify(labels, null, 2)}\n`)
  console.log(`To label: ${file}`)
}
process.exit(results.some(r => r.fails.length) || errors ? 1 : 0)
