import { atom, read } from 'claude-code'
import type { On } from 'claude-code'

import type { ProgressJob } from '../types'
import { bar, bounce, fit, fmtBytes, fmtDuration, spinner } from './format'
import { isVisible } from './jobs'

const jobsAtom = atom({ plugin: 'progress-bar', key: 'jobs' } as const, [] as ProgressJob[])
const hiddenAtom = atom({ plugin: 'progress-bar', key: 'isHidden' } as const, false)
const nowAtom = atom({ plugin: 'progress-bar', key: 'now' } as const, 0)

function describe(job: ProgressJob, now: number): string {
  const parts: string[] = []
  if (job.fraction !== undefined) parts.push(`${Math.floor(job.fraction * 100)}%`.padStart(4))
  if (job.unit === 'bytes' && job.done !== undefined) {
    parts.push(job.total ? `${fmtBytes(job.done)}/${fmtBytes(job.total)}` : fmtBytes(job.done))
    if (job.status === 'running' && job.rate) parts.push(`${fmtBytes(job.rate)}/s`)
  } else if (job.unit === 'items' && job.done !== undefined && job.total) {
    parts.push(`${job.done}/${job.total}`)
  }
  if (job.status === 'running') {
    if (job.etaSeconds !== undefined && Number.isFinite(job.etaSeconds)) parts.push(`ETA ${fmtDuration(job.etaSeconds)}`)
    else parts.push(fmtDuration((now - job.startedAt) / 1000))
  } else {
    parts.push(`${job.status === 'done' ? 'done' : 'failed'} in ${fmtDuration(((job.finishedAt ?? now) - job.startedAt) / 1000)}`)
  }
  if (job.detail) parts.push(`· ${job.detail}`)
  return parts.join('  ')
}

export function registerBand(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) return next(e)

    const now = await read($, nowAtom)
    const all = await read($, jobsAtom)
    const shown = all
      .filter(j => isVisible(j, now, all))
      .sort((a, b) => Number(a.status !== 'running') - Number(b.status !== 'running') || a.startedAt - b.startedAt)
      .slice(0, Math.max(1, e.props.maxRows))
    if (shown.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    // One width for all rows keeps the bars aligned. The label gets the room left after a minimum bar and
    // the info column (detail excluded: it is the part allowed to be cut); the bar shrinks before the label does.
    const MIN_BAR = 10
    const MAX_BAR = 36
    const infoReserve = Math.min(32, Math.max(...shown.map(j => describe({ ...j, detail: undefined }, now).length)))
    const longestLabel = Math.max(...shown.map(j => [...j.label].length))
    const labelWidth = Math.max(12, Math.min(longestLabel, cols - MIN_BAR - infoReserve - 5))
    const barWidth = Math.min(MAX_BAR, Math.max(MIN_BAR, cols - labelWidth - infoReserve - 5))
    const tick = Math.floor(now / 1000)

    return (
      <Box flexDirection="column">
        {shown.map(job => {
          const icon = job.status === 'running' ? spinner(tick) : job.status === 'done' ? '✓' : '✗'
          const iconColor = job.status === 'failed' ? 'error' : job.status === 'done' ? 'success' : 'claude'
          const info = describe(job, now)
          const infoWidth = Math.max(0, cols - labelWidth - barWidth - 5)
          if (job.fraction === undefined && job.status === 'running') {
            const [before, block, after] = bounce(tick, barWidth)
            return (
              <Box key={job.id} flexDirection="row">
                <Text color={iconColor}>{icon} </Text>
                <Text>{fit(job.label, labelWidth)} </Text>
                <Text dimColor>{before}</Text>
                <Text color="claude">{block}</Text>
                <Text dimColor>{after}</Text>
                <Text dimColor> {fit(info, infoWidth)}</Text>
              </Box>
            )
          }
          const [filled, empty] = bar(job.fraction ?? 0, barWidth)
          return (
            <Box key={job.id} flexDirection="row">
              <Text color={iconColor}>{icon} </Text>
              <Text>{fit(job.label, labelWidth)} </Text>
              <Text color={job.status === 'failed' ? 'error' : 'success'}>{filled}</Text>
              <Text dimColor>{empty}</Text>
              <Text> {fit(info, infoWidth)}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
