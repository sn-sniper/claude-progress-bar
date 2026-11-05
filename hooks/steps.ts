import type { Step } from '../types'

/**
 * Splits a shell command at its top-level `&&`, `||`, `;`, `&` and newlines. Pipes stay inside a segment,
 * and so do quotes and `$( )`. Grouping parens and braces are dropped, so `(a; b) && c` is three segments.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let substDepth = 0
  const push = () => {
    const s = current.trim()
    if (s) segments.push(s)
    current = ''
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    const next = command[i + 1]
    if (quote) {
      if (c === '\\' && quote === '"') { current += c + (next ?? ''); i++; continue }
      if (c === quote) quote = undefined
      current += c
      continue
    }
    if (c === '\\') { current += c + (next ?? ''); i++; continue }
    if (c === '"' || c === "'") { quote = c; current += c; continue }
    if (c === '$' && next === '(') { substDepth++; current += '$('; i++; continue }
    if (substDepth > 0) {
      if (c === '(') substDepth++
      if (c === ')') substDepth--
      current += c
      continue
    }
    if ((c === '&' && next === '&') || (c === '|' && next === '|')) { push(); i++; continue }
    // `&>` and `>&` are redirects, not a background `&`.
    if (c === '&' && next !== '>' && command[i - 1] !== '>') { push(); continue }
    if (c === ';' || c === '\n') { push(); continue }
    if (c === '(' || c === ')') { push(); continue }
    if ((c === '{' || c === '}') && current.trim() === '' ) { push(); continue }
    current += c
  }
  push()
  return segments.filter(s => s !== '}')
}

const unquote = (s: string) => s.replace(/^(['"])([\s\S]*)\1$/, '$2')

// Wrappers that run the rest of the line: the step is what they run.
const PREFIX = /^(?:(?:[A-Za-z_]\w*=\S*|sudo(?:\s+-\S+)*|pkexec|nice(?:\s+-n\s*-?\d+)?|time|env|nohup|stdbuf\s+\S+|timeout(?:\s+-\S+)*\s+\d+\w?|command)\s+)+/

const KINDS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^git\s+(?:-C\s+\S+\s+)?(commit|push|pull|fetch|clone|rebase|merge)\b/, m => m[1]!],
  [/^(?:flutter|dart)\s+test\b|^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|^(?:npx\s+|bunx\s+)?(?:pytest|jest|vitest|mocha|playwright\s+test)\b|^python3?\s+-m\s+pytest\b|^(?:go|cargo)\s+test\b|^(?:\.\/)?gradlew?\s+\S*test/i, () => 'tests'],
  [/^flutter\s+build\s+(\w+)/, m => `build ${m[1]}`],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|^(?:cargo|go)\s+build\b|^(?:\.\/)?gradlew?\s|^make\b|^cmake\s+--build\b|^docker\s+(?:compose\s+)?build\b|^(?:npx\s+)?tsc\b/, () => 'build'],
  [/^adb\s+(?:-s\s+\S+\s+)?install|^flutter\s+install\b/, () => 'install'],
  [/^(?:flutter|dart)\s+analyze\b|^(?:npx\s+)?(?:eslint|ruff|mypy)\b|^cargo\s+clippy\b/, () => 'analyze'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i|add)\b|^(?:flutter|dart)\s+pub\s+get\b|^pip3?\s+install\b|^uv\s+(?:sync|pip)\b/, () => 'deps'],
  [/^(?:apt-get|apt)\s+(?:-\S+\s+)*(\w[\w-]*)/, m => `apt ${m[1]}`],
  [/^docker\s+compose\s+(up|pull|down)\b/, m => `docker ${m[1]}`],
  [/^(?:curl|wget|aria2c)\b/, () => 'download'],
]

// Setup and plumbing around the real work; never a step of its own.
const TRIVIAL = /^(?:cd|echo|printf|export|unset|cp|mv|rm|mkdir|sed|cat|ls|true|false|test|\[\[?|sleep|set|source|\.|wait|touch|chmod|chown|grep|tail|head|wc|date|pwd|which|type|exit|trap|read|tee|ln|basename|dirname|local|return|shift)(?:\s|$)|^[A-Za-z_]\w*=/

function classify(segment: string): { label: string; key: string } | undefined {
  const body = segment.replace(PREFIX, '')
  if (TRIVIAL.test(body)) return undefined
  for (const [re, label] of KINDS) {
    const m = body.match(re)
    if (m) return { label: label(m), key: label(m) }
  }
  // `git add`, `git log`, `git status`: bookkeeping around a commit or push, too quick to be a step.
  if (/^git\s/.test(body)) return undefined
  const word = body.split(/\s/)[0]?.split('/').at(-1)
  if (!word) return undefined
  // Unknown tools key on the command itself with quoted text and numbers blanked, so a new commit
  // message or timestamp still finds the old timings.
  return { label: word, key: body.replace(/(['"])[\s\S]*?\1/g, "''").replace(/\d+/g, 'N').replace(/\s+/g, ' ').slice(0, 120) }
}

const ASSIGN = /^(?:export\s+)?([A-Za-z_]\w*)=(\S*)$/

function expand(word: string, vars: Map<string, string>, home: string | undefined): string | undefined {
  let out = unquote(word)
  if (out.startsWith('~/') && home) out = home + out.slice(1)
  let isResolved = true
  out = out.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (_, name: string) => {
    const v = name === 'HOME' ? home : vars.get(name)
    if (v === undefined) isResolved = false
    return v ?? ''
  })
  return isResolved ? out : undefined
}

const REDIRECT = /(?:^|[\s;|])(?:\d?>>?|&>>?)\s*([^\s;&|<>()]+)/g
const TEE = /\btee\s+(?:-a\s+)?([^\s;&|<>()]+)/g

function logsOf(segment: string, vars: Map<string, string>, cwd: string | undefined, home: string | undefined): string[] {
  const targets = [...segment.matchAll(REDIRECT), ...segment.matchAll(TEE)].map(m => m[1]!).filter(t => !t.startsWith('&'))
  const logs: string[] = []
  for (const target of targets) {
    let path = expand(target, vars, home)
    if (!path || path === '/dev/null') continue
    if (!path.startsWith('/')) {
      if (!cwd) continue
      path = `${cwd.replace(/\/$/, '')}/${path}`
    }
    if (!logs.includes(path)) logs.push(path)
  }
  return logs
}

const MARKER = /^(?:echo|printf)\s+(?:-\w+\s+)?['"]?([^$%\\'"`]{3,})/

/**
 * The steps of a background command, and the key its timings are remembered under. `sh -c '…'` (as a
 * pkexec call wraps its work) is read through to the command inside.
 */
export function parseSteps(command: string, where: { home?: string; cwd?: string } = {}): { steps: Step[]; key: string } {
  const { home } = where
  const vars = new Map<string, string>()
  let cwd = where.cwd
  const steps: (Step & { key: string })[] = []

  const walk = (cmd: string) => {
    for (const segment of splitSegments(cmd)) {
      const inner = segment.replace(PREFIX, '').match(/^(?:ba|z|da)?sh\s+-c\s+(['"])([\s\S]*)\1$/)
      if (inner) { walk(inner[2]!); continue }

      const assign = segment.match(ASSIGN)
      if (assign) {
        const v = expand(assign[2]!, vars, home)
        if (v !== undefined) vars.set(assign[1]!, v)
        continue
      }
      const cd = segment.match(/^cd\s+(\S+)$/)
      if (cd) {
        const dir = expand(cd[1]!, vars, home)
        cwd = dir === undefined ? undefined : dir.startsWith('/') ? dir : cwd && `${cwd}/${dir}`
        continue
      }
      const last = steps.at(-1)
      const marker = segment.match(MARKER)?.[1]?.trim()
      if (marker && marker.length >= 3 && last && !last.marker) last.marker = marker

      const kind = classify(segment)
      if (!kind) continue
      const logs = logsOf(segment, vars, cwd, home)
      if (last && last.label === kind.label && !last.marker) {
        last.logs.push(...logs.filter(l => !last.logs.includes(l)))
        continue
      }
      steps.push({ label: kind.label, key: kind.key, logs })
    }
  }
  walk(command)

  const key = `${cwd ?? ''}|${steps.map(s => s.key).join('>')}`
  return { steps: steps.map(({ key: _key, ...s }) => s), key }
}
