import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { PlanItem, ProgressJob } from '../types'
import { registerBand } from './band'
import { applySample, finish, newJob, patch, planJob, prune, upsert } from './jobs'
import { parseOutputPath, parseProgress, parseTaskNotices } from './parse'
import type { Sample } from './parse'

type Engine = EngineInterface
type Jobs = ProgressJob[]

const jobsAtom = atom({ plugin: 'progress-bar', key: 'jobs' } as const, [] as ProgressJob[])
const hiddenAtom = atom({ plugin: 'progress-bar', key: 'isHidden' } as const, false)
const nowAtom = atom({ plugin: 'progress-bar', key: 'now' } as const, 0)
const tasksAtom = atom({ plugin: 'progress-bar', key: 'tasks' } as const, {} as Record<string, PlanItem>)

const REPORT_TOOL = 'mcp__progress-bar__report'
const POLL_MS = 2000
const LIVE_AGENT = new Set(['pending', 'running', 'waiting'])
// Instant or bookkeeping tools: a "running" row for them would only flicker.
const UNTRACKED = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'AskUserQuestion', 'ToolSearch', REPORT_TOOL])

const REPORT_DESCRIPTION = [
  "Shows live progress (bar, %, ETA) in the user's progress band above the prompt.",
  'Background Bash commands, TodoWrite/Task lists, subagents and workflows are tracked automatically; call this only to add what they cannot know:',
  '(1) multi-phase work of your own: call with label and total (phases), then done=<n> and detail=<current phase> after each phase, status="done" at the end;',
  '(2) a background command whose output prints no percentage: id=<its background task id>, total=<expected bytes or lines>, and watch=<absolute path of the file it writes> (measure="lines" to count lines instead of bytes), polled every 2s.',
].join(' ')

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const summarize = (input: Record<string, unknown>) => {
  for (const key of ['description', 'command', 'url', 'file_path', 'pattern', 'query', 'prompt']) {
    const v = str(input[key])
    if (v) return v.split('\n')[0]
  }
  return undefined
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (block === null || typeof block !== 'object') return ''
      const b = block as { text?: unknown; content?: unknown }
      return typeof b.text === 'string' ? b.text : textOf(b.content)
    })
    .join('\n')
}

function syncAgents(jobs: Jobs, agents: AgentInfo[], now: number): Jobs {
  const byId = new Map(agents.map(a => [`agent:${a.id}`, a]))
  let next = jobs
  for (const a of agents) {
    const id = `agent:${a.id}`
    if (LIVE_AGENT.has(a.status) && !next.some(j => j.id === id)) {
      next = upsert(next, newJob({ id, kind: 'agent', label: a.description || a.type, detail: a.type }, now))
    }
  }
  return next.map(job => {
    if (job.kind !== 'agent' || job.status !== 'running') return job
    const a = byId.get(job.id)
    if (a && LIVE_AGENT.has(a.status)) return job
    return finish(job, a?.status === 'failed' || a?.status === 'killed' ? 'failed' : 'done', now)
  })
}

// Module state: a hot reload starts it over, which only costs one early poll.
let isPolling = false
let lastPollAt = 0

async function mutate($: Engine, fn: (jobs: Jobs, now: number) => Jobs) {
  const now = await $.clock.now()
  await update($, jobsAtom, jobs => prune(fn(jobs, now), now))
  await update($, nowAtom, () => now)
}

// $.fs.read refuses files over 4 MiB; past that a job keeps its last sample and shows elapsed time.
const MAX_READ_BYTES = 4 * 1024 * 1024
const TAIL_CHARS = 16384

async function readSmall($: Engine, path: string): Promise<string | undefined> {
  const { size } = await $.fs.stat(path)
  return size <= MAX_READ_BYTES ? String(await $.fs.read(path)) : undefined
}

async function sample($: Engine, job: ProgressJob): Promise<Sample | undefined> {
  try {
    if (job.watch) {
      if (job.measure === 'lines') {
        const text = await readSmall($, job.watch)
        return text === undefined ? undefined : { done: text.split('\n').length - 1, unit: 'items' }
      }
      return { done: (await $.fs.stat(job.watch)).size, unit: 'bytes' }
    }
    if (job.outputFile) {
      const text = await readSmall($, job.outputFile)
      return text === undefined ? undefined : parseProgress(text.slice(-TAIL_CHARS))
    }
  } catch (err) {
    // The file may not exist yet; the next poll tries again.
    $.ui.log(`progress-bar: sampling ${job.id} failed: ${String(err)}`, { to: 'debug' })
  }
  return undefined
}

async function tick($: Engine) {
  if (isPolling) return
  isPolling = true
  try {
    const now = await $.clock.now()
    const jobs = await read($, jobsAtom)
    if (jobs.length === 0) return

    const samples = new Map<string, Sample>()
    let agents: AgentInfo[] | undefined
    if (now - lastPollAt >= POLL_MS) {
      lastPollAt = now
      for (const job of jobs) {
        if (job.status !== 'running' || (!job.watch && !job.outputFile)) continue
        const s = await sample($, job)
        if (s) samples.set(job.id, s)
      }
      agents = await $.agent.list()
    }

    await mutate($, (current, at) => {
      const sampled = current.map(j => {
        const s = samples.get(j.id)
        return s && j.status === 'running' ? applySample(j, s, at) : j
      })
      return agents ? syncAgents(sampled, agents, at) : sampled
    })
  } finally {
    isPolling = false
  }
}

async function syncPlan($: Engine, items: PlanItem[]) {
  await mutate($, (jobs, now) => {
    const job = planJob(jobs.find(j => j.id === 'plan'), items, now)
    return job ? upsert(jobs, job) : jobs
  })
}

async function afterTool($: Engine, tool: string, input: Record<string, unknown>, result: unknown, text: string | undefined) {
  const r = (result ?? {}) as Record<string, unknown>
  switch (tool) {
    case 'Bash': {
      const taskId = str(r.backgroundTaskId)
      if (!taskId) return
      const label = str(input.description) ?? str(input.command) ?? 'background command'
      await mutate($, (jobs, now) => upsert(jobs, newJob({ id: taskId, kind: 'shell', label, outputFile: parseOutputPath(text) }, now)))
      return
    }
    case 'Workflow': {
      const taskId = str(r.taskId)
      if (!taskId) return
      await mutate($, (jobs, now) => upsert(jobs, newJob({ id: taskId, kind: 'workflow', label: `workflow ${str(r.workflowName) ?? ''}`.trim() }, now)))
      return
    }
    case 'TodoWrite': {
      if (Array.isArray(r.newTodos)) await syncPlan($, r.newTodos as PlanItem[])
      return
    }
    case 'TaskCreate': {
      const task = r.task as { id?: string; subject?: string } | undefined
      if (!task?.id) return
      const id = task.id
      const item: PlanItem = { subject: task.subject ?? str(input.subject) ?? id, status: 'pending', activeForm: str(input.activeForm) }
      await update($, tasksAtom, tasks => {
        const all = Object.values(tasks)
        // A fresh list after a finished one starts a new plan instead of diluting it with old completions.
        const base = all.length > 0 && all.every(t => t.status === 'completed') ? {} : tasks
        return { ...base, [id]: item }
      })
      await syncPlan($, Object.values(await read($, tasksAtom)))
      return
    }
    case 'TaskUpdate': {
      const id = str(input.taskId)
      if (!id) return
      await update($, tasksAtom, tasks => {
        const { [id]: current, ...rest } = tasks
        if (input.status === 'deleted' || !current) return rest
        const status: PlanItem['status'] =
          input.status === 'pending' || input.status === 'in_progress' || input.status === 'completed' ? input.status : current.status
        const item: PlanItem = { ...current, status, subject: str(input.subject) ?? current.subject, activeForm: str(input.activeForm) ?? current.activeForm }
        return { ...rest, [id]: item }
      })
      await syncPlan($, Object.values(await read($, tasksAtom)))
      return
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'report',
      description: REPORT_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job id: a background task id to enrich that command; omit for your own phased work.' },
          label: { type: 'string', description: 'Short name shown in the band.' },
          percent: { type: 'number', description: '0-100, when you know it directly.' },
          done: { type: 'number' },
          total: { type: 'number' },
          unit: { type: 'string', enum: ['items', 'bytes'] },
          eta_seconds: { type: 'number', description: 'Only when the work itself reports an ETA; otherwise it is computed.' },
          detail: { type: 'string', description: 'Current step, e.g. "Phase 3/5: running tests".' },
          watch: { type: 'string', description: 'Absolute path of a file whose growth is the progress; polled every 2s.' },
          measure: { type: 'string', enum: ['bytes', 'lines'], description: 'What `watch` counts: its size (default) or its lines.' },
          status: { type: 'string', enum: ['running', 'done', 'failed'] },
        },
      },
    })
    await $.command.register({ name: 'progress', description: 'Progress band: /progress [show|hide|clear]' })
    $.clock.every(1000, () => void tick($))
    return next(e)
  })

  on('tool.call', { tool: REPORT_TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const label = str(input.label)
    const id = str(input.id) ?? `report:${label ?? 'progress'}`
    const watch = str(input.watch)
    const measure = input.measure === 'lines' ? 'lines' : 'bytes'

    if (watch) {
      // The file is read every 2s outside the Read tool, so it must be one the person's rules already let Claude read.
      const verdict = await $.tool.check({ tool: 'Read', input: { file_path: watch } })
      if (verdict.decision !== 'allow') {
        return { result: `Watch not accepted: the permission rules answer "${verdict.decision}" for reading ${watch}. Report done/percent yourself instead.` }
      }
    }

    const status = input.status === 'done' || input.status === 'failed' ? input.status : undefined
    const unit = input.unit === 'bytes' || input.unit === 'items' ? input.unit : undefined
    const percent = num(input.percent)
    await mutate($, (jobs, now) => {
      const existing = jobs.find(j => j.id === id)
      let job = existing ?? newJob({ id, kind: 'report', label: label ?? 'Progress' }, now)
      if (label && existing?.kind === 'report') job = { ...job, label }
      if (watch) job = { ...job, watch, measure, unit: measure === 'lines' ? 'items' : 'bytes' }
      job = applySample(job, {
        fraction: percent === undefined ? undefined : percent / 100,
        done: num(input.done),
        total: num(input.total),
        unit,
        etaSeconds: num(input.eta_seconds),
        detail: str(input.detail),
      }, now)
      return upsert(jobs, status ? finish(job, status, now) : job)
    })
    return { result: `Progress band updated for "${label ?? id}"${watch ? `; watching ${watch} every 2s` : ''}.` }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const rowId = `tool:${String(input.tool_use_id ?? Math.random())}`
    const isTracked = !UNTRACKED.has(tool) && input.agentId === undefined

    if (isTracked) {
      const summary = summarize(input)
      await mutate($, (jobs, now) => upsert(jobs, newJob({ id: rowId, kind: 'tool', label: summary ? `${tool}: ${summary}` : tool }, now)))
    }
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      if (isTracked) await mutate($, jobs => jobs.filter(j => j.id !== rowId))
    }
    if (ran.deny === undefined && ran.isError !== true) await afterTool($, tool, input, ran.result, ran.text)
    return ran
  })

  on('session.append', async ($, e, next) => {
    const text = textOf(e.message.content)
    if (text.includes('<task-notification>')) {
      const notices = parseTaskNotices(text)
      if (notices.length > 0) {
        await mutate($, (jobs, now) =>
          notices.reduce((acc, n) => patch(acc, n.taskId, j => finish(j, n.status === 'completed' ? 'done' : 'failed', now)), jobs),
        )
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await mutate($, (jobs, now) => upsert(jobs.filter(j => j.kind !== 'turn'), newJob({ id: 'turn', kind: 'turn', label: 'Claude working' }, now)))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await mutate($, jobs => jobs.filter(j => j.kind !== 'turn' && j.kind !== 'tool'))
    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await update($, jobsAtom, () => [])
      await update($, tasksAtom, () => ({}))
      return { text: 'Progress band cleared.' }
    }
    const isHidden = arg === 'hide' ? true : arg === 'show' ? false : !(await read($, hiddenAtom))
    await update($, hiddenAtom, () => isHidden)
    return { text: isHidden ? 'Progress band hidden; /progress show brings it back.' : 'Progress band shown.' }
  })

  registerBand(on)
}
