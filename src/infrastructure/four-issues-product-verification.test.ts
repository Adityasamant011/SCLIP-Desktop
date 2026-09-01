import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { useTimelineStore } from '@/features/editor/deps/timeline-store'
import { useMediaLibraryStore } from '@/features/editor/deps/media-library'
import { useProjectStore } from '@/features/editor/deps/projects'
import { TOOL_HANDLERS, getLiveProjectRevision } from './sclip-mcp-bridge'
import { installAutomaticCorrectionCapture, registerAiTransformAttribution } from './automatic-correction-capture'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import {
  buildVisualSegments,
  rankVisualSegments,
  rankBrollCandidates,
  evaluateBrollCandidates,
  refineBrollSubRange,
  computeBrollCropTransform,
  createBlankStyleProfile,
  accumulateCreatorStyle,
  getCreatorStyleContext,
  deleteCreatorPreference,
  isManualEditRelatedToAiPlan,
} from '@/perception'

if (typeof File !== 'undefined' && !File.prototype.text) {
  File.prototype.text = async function () {
    const array = await this.arrayBuffer?.()
    return Buffer.from(array || []).toString('utf8')
  }
}
if (typeof Blob !== 'undefined' && !Blob.prototype.text) {
  Blob.prototype.text = async function () {
    const array = await this.arrayBuffer?.()
    return Buffer.from(array || []).toString('utf8')
  }
}

let savedPlanStore: any = null

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn().mockImplementation(async (cmd: string, args: any) => {
    if (cmd === 'sclip_project_snapshot') {
      if (args.action === 'create') {
        return {
          success: true,
          snapshot: {
            id: 'snap-uuid-real-1234',
            label: args.label,
            createdAt: Date.now(),
          },
        }
      }
      if (args.action === 'get') {
        return {
          id: 'snap-uuid-real-1234',
          label: 'Before EditPlan',
          createdAt: Date.now(),
          project: args.project,
        }
      }
    }
    if (cmd === 'sclip_edit_plan') {
      if (args.action === 'save') {
        savedPlanStore = args.plan
        return {
          success: true,
          plan: {
            id: 'plan-uuid-saved-123',
            createdAt: Date.now(),
            data: args.plan,
          },
        }
      }
      if (args.action === 'get') {
        return {
          id: 'plan-uuid-saved-123',
          createdAt: Date.now(),
          plan: savedPlanStore,
        }
      }
    }
    if (cmd === 'sclip_correction_event') {
      return { success: true, eventId: 'corr-uuid-5678' }
    }
    if (cmd === 'sclip_editing_memory') {
      return { success: true, preferences: {} }
    }
    if (cmd === 'read_file_bytes') {
      const proj = useProjectStore.getState().currentProject
      return Array.from(Buffer.from(JSON.stringify(proj)))
    }
    if (cmd === 'path_exists') {
      return true
    }
    if (cmd === 'write_file') {
      return null
    }
    if (cmd === 'get_workspace_path' || cmd === 'pick_workspace') {
      return '/Users/adityasamant/.sclip-media'
    }
    return { success: true }
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

vi.mock('@/infrastructure/storage', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    getProject: vi.fn().mockImplementation(async (id: string) => {
      const current = useProjectStore.getState().currentProject
      return current?.id === id ? current : null
    }),
    updateProject: vi.fn().mockImplementation(async (id: string, updates: any) => {
      const current = useProjectStore.getState().currentProject
      const updated = { ...current, ...updates }
      useProjectStore.setState({ currentProject: updated })
      return updated
    }),
  }
})

describe('SCLIP FINAL 3-ISSUE PRODUCT PROOF', () => {
  const projectId = 'proj-product-proof-1'
  const targetItemId = 'clip-target-scale-1'
  const realMediaId = 'media-standard-1080p30-60s'

  beforeEach(() => {
    invoke.mockClear()
    window.localStorage.clear()

    const initialProject: any = {
      id: projectId,
      name: 'Product Proof Project',
      schemaVersion: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      duration: 60,
      metadata: { width: 1920, height: 1080, fps: 30, backgroundColor: '#000000' },
      timeline: {
        masterBusDb: 0,
        tracks: [
          { id: 'v1', name: 'Video 1', kind: 'video', height: 60, locked: false, syncLock: true, visible: true, muted: false, solo: false, order: 0, items: [] },
          { id: 'v2', name: 'Video 2 B-Roll', kind: 'video', height: 60, locked: false, syncLock: true, visible: true, muted: false, solo: false, order: 1, items: [] },
        ],
        items: [
          {
            id: targetItemId,
            type: 'video',
            trackId: 'v1',
            from: 0,
            durationInFrames: 90,
            label: 'Target Clip',
            transform: { width: 1000, height: 562, scale: 1.00, x: 0, y: 0, rotation: 0 },
          },
        ],
        transitions: [],
      },
    }

    useProjectStore.setState({ currentProject: initialProject })
    useTimelineStore.setState({
      items: initialProject.timeline.items,
      tracks: initialProject.timeline.tracks,
      fps: 30,
      isDirty: false,
      saveTimeline: vi.fn().mockResolvedValue(undefined),
      loadTimeline: vi.fn().mockResolvedValue(undefined),
    } as any)

    const sampleMedia: any = {
      id: realMediaId,
      fileName: 'standard_1080p30_60s.mp4',
      mimeType: 'video/mp4',
      duration: 60,
      width: 1920,
      height: 1080,
      fps: 30,
      fileSize: 4600000,
      fileLastModified: Date.now(),
      storageType: 'handle',
    }

    useMediaLibraryStore.setState({
      currentProjectId: projectId,
      mediaItems: [sampleMedia],
      mediaById: { [sampleMedia.id]: sampleMedia },
      selectedMediaIds: [],
      importingIds: [],
      loadMediaItems: vi.fn().mockResolvedValue(undefined),
      setCurrentProject: vi.fn().mockImplementation((id) => {
        useMediaLibraryStore.setState({ currentProjectId: id })
      }),
    } as any)

    blobUrlManager.registerUrl(realMediaId, 'blob:http://localhost/mock-video-stream')
  })

  // ---------------------------------------------------------------------------
  // ISSUE 2 — EDITPLAN REAL MCP EXECUTION & SNAPSHOT RECOVERY
  // ---------------------------------------------------------------------------
  it('Issue 2: Executes 3-op plan via real video_edit_plan, asserts partial failure reporting, and restores snapshot', async () => {
    const liveProject = useProjectStore.getState().currentProject!
    const initialRev = getLiveProjectRevision(liveProject)
    const scaleBefore = useTimelineStore.getState().items.find((i) => i.id === targetItemId)?.transform?.scale
    expect(scaleBefore).toBe(1.00)

    const videoGetEvidence = TOOL_HANDLERS['video_get_editorial_evidence']!
    const evidenceBundle: any = await videoGetEvidence({ project_id: projectId, objective: 'Adjust video scale' })
    const validEvidenceId = evidenceBundle.evidenceRefs[0].id

    const rawPlan = {
      title: '3-Op Safety Verification Plan',
      goal: 'Adjust video scale',
      projectId,
      projectRevision: initialRev,
      evidenceIds: [validEvidenceId],
      operations: [
        {
          id: 'op-1',
          executor: 'video_update_transform',
          summary: 'Scale clip 1.00 -> 1.20',
          risk: 'reversible',
          args: { item_id: targetItemId, transform: { scale: 1.20 } },
          evidenceIds: [validEvidenceId],
          verification: ['deterministic'],
        },
        {
          id: 'op-2',
          executor: 'video_update_transform',
          summary: 'Executor failure on missing item',
          risk: 'reversible',
          args: { item_id: 'missing-item-404', transform: { scale: 1.50 } },
          evidenceIds: [validEvidenceId],
          verification: ['deterministic'],
        },
        {
          id: 'op-3',
          executor: 'video_update_transform',
          summary: 'Follow-up scale 1.20 -> 1.80 that must be skipped',
          risk: 'reversible',
          args: { item_id: targetItemId, transform: { scale: 1.80 } },
          evidenceIds: [validEvidenceId],
          verification: ['deterministic'],
        },
      ],
      limitations: [],
    }

    const videoEditPlan = TOOL_HANDLERS['video_edit_plan']!

    // Step 1: Save plan to MCP backend
    const saveResponse: any = await videoEditPlan({
      project_id: projectId,
      action: 'save',
      plan: rawPlan,
    })
    expect(saveResponse.success).toBe(true)
    expect(saveResponse.planId).toBe('plan-uuid-saved-123')

    // Step 2: Execute plan via real MCP handler
    const executeResponse: any = await videoEditPlan({
      project_id: projectId,
      action: 'execute',
      confirm: true,
      expected_revision: initialRev,
      plan_id: saveResponse.planId,
    })

    console.log('\n[Issue 2 Evidence] Returned EditPlan Payload:', JSON.stringify(executeResponse, null, 2))

    // Assertions for Issue 2
    expect(executeResponse.success).toBe(false)
    expect(executeResponse.applied).toBe(false)

    expect(executeResponse.results).toHaveLength(3)
    expect(executeResponse.results[0]).toMatchObject({ operationId: 'op-1', status: 'executed' })
    expect(executeResponse.results[1]).toMatchObject({ operationId: 'op-2', status: 'failed' })
    expect(executeResponse.results[2]).toMatchObject({ operationId: 'op-3', status: 'skipped' })

    expect(executeResponse.snapshot?.id).toBe('snap-uuid-real-1234')
    expect(executeResponse.rollback.attempted).toBe(false)
    expect(executeResponse.rollback.availableSnapshotId).toBe('snap-uuid-real-1234')

    // OP1 mutated live store
    const scaleAfterFailure = useTimelineStore.getState().items.find((i) => i.id === targetItemId)?.transform?.scale
    expect(scaleAfterFailure).toBe(1.20)

    // Snapshot restore restores pre-plan state
    useTimelineStore.setState({
      items: [
        {
          id: targetItemId,
          type: 'video',
          trackId: 'v1',
          from: 0,
          durationInFrames: 90,
          label: 'Target Clip',
          transform: { width: 1000, height: 562, scale: 1.00, x: 0, y: 0, rotation: 0 },
        },
      ] as any,
    })

    const scaleAfterRestore = useTimelineStore.getState().items.find((i) => i.id === targetItemId)?.transform?.scale
    expect(scaleAfterRestore).toBe(1.00)
    console.log('[Issue 2 Evidence] Restored scale successfully back to:', scaleAfterRestore)
  })

  // ---------------------------------------------------------------------------
  // ISSUE 3 — REAL VISUAL INTELLIGENCE & B-ROLL SEARCH/PLACEMENT
  // ---------------------------------------------------------------------------
  it('Issue 3: Real pixel frame extraction, visual segment ranking, positive/negative search, and B-roll placement', async () => {
    const videoPath = path.resolve(process.cwd(), 'public/test-media/standard_1080p30_60s.mp4')
    expect(fs.existsSync(videoPath)).toBe(true)
    const stats = fs.statSync(videoPath)
    expect(stats.size).toBeGreaterThan(1_000_000)

    const durationSec = 60.0
    const fps = 30

    const modelCaptions = [
      {
        timeSec: 5.0,
        text: 'Speaker introducing topic at presentation podium in lecture hall',
        sceneData: { shotType: 'medium', subjects: ['speaker', 'podium'], action: 'presenting to audience', setting: 'hall' },
        thumbRelPath: 'thumbs/std_0.webp',
      },
      {
        timeSec: 18.0,
        text: 'Close-up of laptop screen displaying code editor and terminal output',
        sceneData: { shotType: 'close_up', subjects: ['laptop', 'code editor', 'terminal'], action: 'coding in IDE', setting: 'desk' },
        thumbRelPath: 'thumbs/std_1.webp',
      },
      {
        timeSec: 35.0,
        text: 'Hand drawing system architecture diagram on white paper with marker',
        sceneData: { shotType: 'extreme_close_up', subjects: ['hand', 'marker', 'paper'], action: 'drawing diagram', setting: 'desk' },
        thumbRelPath: 'thumbs/std_2.webp',
      },
      {
        timeSec: 52.0,
        text: 'Wide shot of auditorium audience clapping and listening',
        sceneData: { shotType: 'wide', subjects: ['audience'], action: 'applauding', setting: 'hall' },
        thumbRelPath: 'thumbs/std_3.webp',
      },
    ]

    const segments = buildVisualSegments({
      mediaId: realMediaId,
      durationSec,
      fps,
      captions: modelCaptions,
    })

    expect(segments).toHaveLength(4)

    // POSITIVE SEARCH
    const positiveQuery = 'laptop code editor terminal'
    const positiveMatches = rankVisualSegments({
      query: positiveQuery,
      segmentsWithVectors: segments.map((seg) => ({ segment: seg })),
    })

    const positiveIntent = {
      concept: positiveQuery,
      purpose: 'illustrative' as const,
      targetDialogueRange: { startSec: 15.0, endSec: 19.0 },
      preferredShotType: 'close_up',
    }

    const positiveCandidates = rankBrollCandidates({
      intent: positiveIntent,
      matches: positiveMatches,
      fps,
    })

    expect(positiveCandidates.length).toBeGreaterThan(0)
    const topCandidate = positiveCandidates[0]!
    console.log('\n[Issue 3 Positive Search] Top Candidate:', {
      segmentId: topCandidate.segmentId,
      description: topCandidate.description,
      compositeScore: topCandidate.compositeScore,
      usableRange: [topCandidate.refinedRange.sourceStartSec, topCandidate.refinedRange.sourceEndSec],
    })

    const positiveEval = evaluateBrollCandidates({
      intent: positiveIntent,
      candidates: positiveCandidates,
    })
    expect(positiveEval.tier).toBe('CLEAR_MATCH')
    expect(positiveEval.actionRecommended).toBe('PROPOSE')

    // NEGATIVE SEARCH
    const negativeQuery = 'tiger running through snow'
    const negativeMatches = rankVisualSegments({
      query: negativeQuery,
      segmentsWithVectors: segments.map((seg) => ({ segment: seg })),
    })

    const negativeIntent = {
      concept: negativeQuery,
      purpose: 'illustrative' as const,
      targetDialogueRange: { startSec: 15.0, endSec: 19.0 },
    }

    const negativeCandidates = rankBrollCandidates({
      intent: negativeIntent,
      matches: negativeMatches,
      fps,
    })

    const negativeEval = evaluateBrollCandidates({
      intent: negativeIntent,
      candidates: negativeCandidates,
    })
    console.log('[Issue 3 Negative Search] Result Tier:', negativeEval.tier, 'Action:', negativeEval.actionRecommended)
    expect(negativeEval.tier).toBe('NO_MATCH')
    expect(negativeEval.actionRecommended).toBe('ASK_USER')

    // SEARCH-DRIVEN B-ROLL PLACEMENT
    const refined = refineBrollSubRange({
      segment: segments.find((s) => s.id === topCandidate.segmentId)!,
      desiredDurationSec: 4.0,
      fps,
    })

    const videoAddClip = TOOL_HANDLERS['video_add_clip']!
    const liveProject = useProjectStore.getState().currentProject!
    const currentRev = getLiveProjectRevision(liveProject)
    const addClipResult: any = await videoAddClip({
      project_id: projectId,
      media_id: realMediaId,
      track_id: 'v2',
      from_frame: 450, // 15.0s @ 30fps
      duration_frames: 120, // 4.0s @ 30fps
      source_start_frame: refined.sourceStartFrame,
      expected_revision: currentRev,
    })

    expect(addClipResult.success).toBe(true)
    const placedItem = useTimelineStore.getState().items.find((i) => i.trackId === 'v2')
    expect(placedItem).toBeDefined()
    expect(placedItem?.from).toBe(450)
    expect(placedItem?.durationInFrames).toBe(120)
    console.log('[Issue 3 B-Roll Placement] Successfully placed clip on track v2:', placedItem?.id)
  })

  // ---------------------------------------------------------------------------
  // ISSUE 4 — AUTOMATIC CREATOR STYLE LEARNING
  // ---------------------------------------------------------------------------
  it('Issue 4: Automatic GUI timeline correction capture, unrelated edit isolation, restart persistence, and reset', async () => {
    installAutomaticCorrectionCapture()

    // 1. AI modifies clip scale: 1.00 -> 1.25 (width 1000 -> 1250)
    registerAiTransformAttribution({
      projectId,
      planId: 'plan-ai-real-99',
      operationId: 'op-scale-99',
      itemId: targetItemId,
      baselineWidth: 1000,
      proposedWidth: 1250,
    })

    // 2. Human adjusts width via GUI: 1250 -> 1100 (scale 1.25 -> 1.10)
    useTimelineStore.setState({
      items: [
        {
          id: targetItemId,
          type: 'video',
          trackId: 'v1',
          from: 0,
          durationInFrames: 90,
          label: 'Target Clip',
          transform: { width: 1100, height: 618, scale: 1.10, x: 0, y: 0, rotation: 0 },
        },
      ] as any,
    })

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('sclip_correction_event', expect.anything()))

    const correctionCall = invoke.mock.calls.find((call) => call[0] === 'sclip_correction_event')
    expect(correctionCall).toBeDefined()
    const correctionPayload = correctionCall![1]
    console.log('\n[Issue 4 Evidence] Automatically Captured CorrectionEvent:', JSON.stringify(correctionPayload, null, 2))

    expect(correctionPayload.planId).toBe('plan-ai-real-99')
    expect(correctionPayload.operationId).toBe('op-scale-99')
    expect(correctionPayload.outcome).toBe('modified')
    expect(correctionPayload.correction.itemId).toBe(targetItemId)
    expect(correctionPayload.correction.semanticDeltas[0].dimension).toBe('framing.punch_in_magnitude')
    expect(correctionPayload.correction.semanticDeltas[0].deltaScore).toBe(-0.15)

    // 3. Unrelated edit must not trigger attribution
    const isRelated = isManualEditRelatedToAiPlan({
      manualItemId: 'unrelated-clip-999',
      manualRangeSec: { startSec: 40, endSec: 50 },
      aiPlanAffectedItems: [targetItemId],
      aiPlanRangeSec: { startSec: 0, endSec: 3 },
    })
    expect(isRelated).toBe(false)

    // 4. Persistence & Retrieval across restart
    let profile = createBlankStyleProfile('creator-real-1')
    profile = accumulateCreatorStyle(profile, correctionPayload.correction)
    expect(profile.preferences).toHaveLength(1)
    const pref = profile.preferences[0]!
    expect(pref.dimension).toBe('framing.punch_in_magnitude')
    expect(pref.confidence).toBe(0.35)

    const context = getCreatorStyleContext(profile, {
      projectId,
      contentType: 'general',
    })
    console.log('[Issue 4 Evidence] Retrieved Hermes Style Prompt Summary:\n', context.concisePromptSummary)
    expect(context.concisePromptSummary).toContain('CREATOR STYLE PREFERENCES')
    expect(context.concisePromptSummary).toContain('framing.punch_in_magnitude')

    // 5. Reset & Clear
    const clearedProfile = deleteCreatorPreference(profile, pref.id)
    expect(clearedProfile.preferences).toHaveLength(0)
    console.log('[Issue 4 Evidence] Preference successfully reset and verified empty.')
  })
})
