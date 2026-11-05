import { expect, test } from 'claude-code/testing'

import { estimate, recordRun, stepCounts } from '../hooks/estimate'
import type { Seen } from '../hooks/estimate'
import { newJob } from '../hooks/jobs'
import { parseProgress } from '../hooks/parse'
import { parseSteps, splitSegments } from '../hooks/steps'

const APK = [
  'cd /work/app && S=/tmp/claude-1/scratch;',
  'git add -A && git commit -q -m "fix: back; returns home" && git log -1 --oneline;',
  'flutter test > $S/test.log 2>&1; echo "tests rc=$?"; tail -1 $S/test.log;',
  '(flutter build apk --release > $S/apk-build.log 2>&1; echo "build rc=$?");',
  'adb install -r build/app/outputs/flutter-apk/app-release.apk',
].join(' ')

test('a chain splits at && ; and parens, but not inside quotes', async () => {
  expect(splitSegments('a && b "x; y" | c; (d; e) && f')).toEqual(['a', 'b "x; y" | c', 'd', 'e', 'f'])
  expect(splitSegments('cmd > log 2>&1 & wait')).toEqual(['cmd > log 2>&1', 'wait'])
})

test('the APK chain becomes commit, tests, build, install with their logs and markers', async () => {
  const { steps, key } = parseSteps(APK)
  expect(steps.map(s => s.label)).toEqual(['commit', 'tests', 'build apk', 'install'])
  expect(steps[1]?.logs).toEqual(['/tmp/claude-1/scratch/test.log'])
  expect(steps[1]?.marker).toBe('tests rc=')
  expect(steps[2]?.logs).toEqual(['/tmp/claude-1/scratch/apk-build.log'])
  expect(key).toBe('/work/app|commit>tests>build apk>install')
  // A new commit message must not lose the timings.
  expect(parseSteps(APK.replace('back; returns home', 'other')).key).toBe(key)
})

test('pkexec sh -c is read through to its steps', async () => {
  const { steps } = parseSteps("pkexec sh -c 'DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y foo'")
  expect(steps.map(s => s.label)).toEqual(['apt update', 'apt install'])
})

test('flutter test and jest counts', async () => {
  expect(parseProgress('00:41 +540 ~2 -1: loading x.dart')).toMatchObject({ done: 543, unit: 'items' })
  expect(parseProgress('04:30 +1332: All tests passed!')?.done).toBe(1332)
  expect(parseProgress('Tests:       2 failed, 38 passed, 40 total')?.fraction).toBe(1)
})

const job0 = () => {
  const { steps, key } = parseSteps(APK)
  return newJob({ id: 'b1', kind: 'shell', label: 'apk', outputFile: '/o', steps, historyKey: key }, 0)
}
const at = (mtimeMs: number, text?: string) => ({ mtimeMs, size: 10, text })

test('with no history the bar still moves by step: step x/n', async () => {
  const job = job0()
  const seen: Seen = { output: 'e7eb811 fix\ntests rc=0\n', logs: { '/tmp/claude-1/scratch/apk-build.log': at(5000) } }
  const e = estimate(job, seen, undefined, 6000)
  expect(e.step).toBe(2)
  expect(e.sample.fraction).toBe(0.5)
  expect(e.sample.detail).toBe('step 3/4: build apk')
  expect(e.isEstimate).toBe(false)
})

test('a run teaches the next: counts and step durations give a real percent', async () => {
  let job = job0()
  const log = '/tmp/claude-1/scratch/test.log'
  const poll = (seen: Seen, now: number) => {
    const e = estimate(job, seen, undefined, now)
    job = { ...job, step: e.step, observed: e.observed }
  }
  // First run: commit, tests from 2s, build from 272s, install from 400s, done at 420s.
  poll({ output: '', logs: {} }, 1000)
  poll({ output: 'x', logs: { [log]: at(2000, '00:01 +3: a') } }, 2000)
  poll({ output: 'tests rc=0', logs: { '/tmp/claude-1/scratch/apk-build.log': at(272_000) } }, 272_000)
  poll({ output: 'tests rc=0\nbuild rc=0', logs: {} }, 400_000)
  const finalSeen: Seen = { output: 'tests rc=0\nbuild rc=0\nSuccess', logs: { [log]: at(2000, '04:30 +1332: All tests passed!') } }
  const learned = recordRun(undefined, job, 420_000, stepCounts(job, finalSeen))
  expect(learned.steps.tests).toEqual({ ms: 270_000, total: 1332 })
  expect(learned.steps['build apk']?.ms).toBe(128_000)

  // Second run, halfway through the tests: 666 of the 1332 tests passed.
  const next = { ...job0(), startedAt: 1_000_000 }
  const e = estimate(next, { output: 'abc', logs: { [log]: at(1_002_000, '02:15 +666: b') } }, learned, 1_137_000)
  expect(e.isEstimate).toBe(true)
  expect(e.sample.detail).toBe('step 2/4: tests 666/1332')
  const pct = Math.round((e.sample.fraction ?? 0) * 100)
  expect(pct > 30 && pct < 40).toBe(true)
  expect((e.sample.etaSeconds ?? 0) > 200).toBe(true)
})

test('a single unknown command falls back to elapsed over its last duration', async () => {
  const { steps, key } = parseSteps('./long-job.sh --fast')
  const job = newJob({ id: 'b2', kind: 'shell', label: 'job', outputFile: '/o', steps, historyKey: key }, 0)
  const e = estimate(job, { output: 'working', logs: {} }, { ms: 100_000, steps: { 'long-job.sh': { ms: 100_000 } }, runs: 1 }, 25_000)
  expect(e.sample.fraction).toBe(0.25)
  expect(e.sample.etaSeconds).toBe(75)
  expect(e.isEstimate).toBe(true)
})
