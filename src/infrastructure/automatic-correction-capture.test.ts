import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/features/editor/deps/projects'
import { useTimelineStore } from '@/features/editor/deps/timeline-store'
import {
  installAutomaticCorrectionCapture,
  registerAiTransformAttribution,
} from './automatic-correction-capture'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({ success: true }) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('automatic creator-style correction capture', () => {
  beforeEach(() => {
    invoke.mockClear()
    window.localStorage.clear()
    useProjectStore.setState({ currentProject: { id: 'project-1' } as never })
    useTimelineStore.setState({
      items: [{
        id: 'clip-1', type: 'video', trackId: 'v1', label: 'clip', from: 0,
        durationInFrames: 100, transform: { width: 1250, height: 700, x: 0, y: 0, rotation: 0 },
      } as never],
    })
  })

  it('records a later GUI width correction against the AI plan and touched item', async () => {
    installAutomaticCorrectionCapture()
    registerAiTransformAttribution({
      projectId: 'project-1', planId: 'plan-1', operationId: 'op-punch-in',
      itemId: 'clip-1', baselineWidth: 1000, proposedWidth: 1250,
    })

    useTimelineStore.setState({
      items: [{
        id: 'clip-1', type: 'video', trackId: 'v1', label: 'clip', from: 0,
        durationInFrames: 100, transform: { width: 1100, height: 616, x: 0, y: 0, rotation: 0 },
      } as never],
    })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

    expect(invoke).toHaveBeenCalledWith('sclip_correction_event', expect.objectContaining({
      action: 'record', projectId: 'project-1', planId: 'plan-1', operationId: 'op-punch-in', outcome: 'modified',
      correction: expect.objectContaining({
        itemId: 'clip-1', capture: 'automatic_gui_timeline_observer',
        semanticDeltas: [expect.objectContaining({ dimension: 'framing.punch_in_magnitude', proposedValue: 1.25, userValue: 1.1 })],
      }),
    }))
  })
})
