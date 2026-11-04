import { expect, test } from 'claude-code/testing'

import { applySample, newJob, planJob } from '../hooks/jobs'
import { parseOutputPath, parseProgress, parseTaskNotices } from '../hooks/parse'

test('aria2c summary line: bytes, percent and the ETA it prints', async () => {
  const s = parseProgress('noise\n[#1a1e03 8.0GiB/13GiB(58%) CN:44 SD:42 DL:792KiB UL:0B(1.2MiB) ETA:2h7m19s]\n')
  expect(s?.unit).toBe('bytes')
  expect(Math.round((s?.fraction ?? 0) * 100)).toBe(58)
  expect(s?.etaSeconds).toBe(2 * 3600 + 7 * 60 + 19)
})

test('apt and tqdm style lines', async () => {
  expect(parseProgress('Progress: [ 45%] [####......]')?.fraction).toBe(0.45)
  const tqdm = parseProgress('40%|████      | 4/10 [00:12<00:18,  2.0it/s]')
  expect(tqdm?.fraction).toBe(0.4)
  expect(tqdm?.etaSeconds).toBe(18)
})

test('bracketed counts and carriage-return redraws keep the newest value', async () => {
  expect(parseProgress('[3/12] Building foo\r[4/12] Building bar')?.fraction).toBe(4 / 12)
  expect(parseProgress('nothing measurable here')).toBeUndefined()
})

test('task notifications and the background output path', async () => {
  const notices = parseTaskNotices('<task-notification>\n<task-id>bd6e70vtz</task-id>\n<status>completed</status>\n</task-notification>')
  expect(notices).toEqual([{ taskId: 'bd6e70vtz', status: 'completed' }])
  expect(parseOutputPath('Command running in background with ID: b1. Output is being written to: /tmp/t/b1.output')).toBe('/tmp/t/b1.output')
})

test('rate and ETA come from successive samples', async () => {
  let job = newJob({ id: 'j', kind: 'shell', label: 'copy' }, 0)
  job = applySample(job, { done: 0, total: 1000, unit: 'bytes' }, 0)
  job = applySample(job, { done: 100 }, 1000)
  expect(job.rate).toBe(100)
  expect(job.etaSeconds).toBe(9)
  expect(job.fraction).toBe(0.1)
})

test('a task list becomes one plan row that finishes when every item is done', async () => {
  const items = [
    { subject: 'a', status: 'completed' as const },
    { subject: 'b', status: 'in_progress' as const, activeForm: 'Doing b' },
    { subject: 'c', status: 'pending' as const },
  ]
  const plan = planJob(undefined, items, 0)
  expect(plan?.done).toBe(1)
  expect(plan?.detail).toBe('Doing b')
  const done = planJob(plan, items.map(i => ({ ...i, status: 'completed' as const })), 5000)
  expect(done?.status).toBe('done')
})
