import { describe, it, expect } from 'vitest'
import {
  getEditingGuidance,
  KNOWLEDGE_MODULES,
  EDITORIAL_KNOWLEDGE_VERSION,
  type EditorialKnowledgeModule,
} from './index.ts'

describe('SCLIP Editorial Knowledge Library (Phase 2A)', () => {
  it('contains valid, versioned knowledge modules with required structure', () => {
    expect(KNOWLEDGE_MODULES.length).toBeGreaterThanOrEqual(15)

    for (const mod of KNOWLEDGE_MODULES) {
      expect(mod.id).toBeTruthy()
      expect(mod.title).toBeTruthy()
      expect(mod.version).toBe('1.0.0')
      expect(mod.topics.length).toBeGreaterThan(0)
      expect(mod.applicableContentTypes.length).toBeGreaterThan(0)
      expect(mod.principles.length).toBeGreaterThan(0)
      expect(mod.avoid.length).toBeGreaterThan(0)
      expect(mod.evidenceNeeded.length).toBeGreaterThan(0)

      // Verify heuristics are structurally typed with calibrationRequired: true
      for (const h of mod.heuristics) {
        expect(h.description).toBeTruthy()
        expect(h.calibrationRequired).toBe(true)
      }

      // Verify source traceability
      expect(mod.sourceRefs.length).toBeGreaterThan(0)
      for (const ref of mod.sourceRefs) {
        expect(ref.author).toBeTruthy()
        expect(ref.work).toBeTruthy()
        expect(ref.year).toBeGreaterThan(1900)
        expect(ref.reference).toBeTruthy()
      }
    }
  })

  describe('Step 6 & 11 — Selective Retrieval & Filtering', () => {
    it('retrieves only talking-head and pacing modules for a talking-head pacing request', () => {
      const response = getEditingGuidance({
        topics: ['retakes', 'pacing', 'pause'],
        contentTypes: ['talking_head'],
      })

      expect(response.version).toBe(EDITORIAL_KNOWLEDGE_VERSION)
      expect(response.modules.length).toBeGreaterThan(0)

      const moduleIds = response.modules.map((m) => m.id)
      expect(moduleIds).toContain('talking_head.retakes-and-false-starts')
      expect(moduleIds).toContain('talking_head.pause-judgement')
      expect(moduleIds).toContain('universal.pacing-and-duration')

      // Should NOT contain unrelated music or sports modules
      expect(moduleIds).not.toContain('music.musical-phrasing')
      expect(moduleIds).not.toContain('sports.impact-anticipation')
    })

    it('retrieves B-roll modules for a visual coverage task', () => {
      const response = getEditingGuidance({
        topics: ['broll', 'cutaway'],
      })

      const moduleIds = response.modules.map((m) => m.id)
      expect(moduleIds).toContain('broll.motivation-categories')
      expect(moduleIds).toContain('broll.timing-and-readability')
      expect(moduleIds).toContain('broll.missing-footage-policy')
      expect(moduleIds).not.toContain('audio.speech-boundary-continuity')
    })

    it('retrieves audio and split-edit modules for dialogue smoothing', () => {
      const response = getEditingGuidance({
        topics: ['audio', 'crossfade', 'breath', 'j_cut'],
      })

      const moduleIds = response.modules.map((m) => m.id)
      expect(moduleIds).toContain('audio.speech-boundary-continuity')
      expect(moduleIds).toContain('audio.breaths-and-room-tone')
      expect(moduleIds).toContain('audio.j-l-cuts')
    })

    it('retrieves musical phrasing and ducking modules for music tasks', () => {
      const response = getEditingGuidance({
        topics: ['music', 'phrasing', 'ducking', 'syncopation'],
      })

      const moduleIds = response.modules.map((m) => m.id)
      expect(moduleIds).toContain('music.musical-phrasing')
      expect(moduleIds).toContain('music.dialogue-intelligibility-ducking')
      expect(moduleIds).toContain('music.beat-alignment-vs-off-beat')
    })

    it('supports mixed-project window retrieval with segmentGenres', () => {
      // Window is a tutorial segment inside a long-form video
      const response = getEditingGuidance({
        topics: ['hook', 'pacing', 'retakes'],
        segmentGenres: ['tutorial', 'talking_head'],
        projectIntent: 'Clear step-by-step instructional masterclass',
      })

      expect(response.projectIntent).toBe('Clear step-by-step instructional masterclass')
      expect(response.contentTypesEvaluated).toEqual(['tutorial', 'talking_head'])
      expect(response.precedenceRules.length).toBe(7)
      expect(response.modules.some((m) => m.id.includes('talking_head'))).toBe(true)
    })
  })

  describe('Step 9 & 12 — Editorial Reasoning Smoke Tests', () => {
    it('Case 1 (Pause Judgement): provides explicit guidance to evaluate meaning before trimming', () => {
      const response = getEditingGuidance({ topics: ['pause', 'pacing'] })
      const pauseModule = response.modules.find((m) => m.id === 'talking_head.pause-judgement')
      expect(pauseModule).toBeDefined()
      expect(pauseModule!.principles).toContain(
        'Distinguish dead hesitations from rhetorical emphasis pauses, comedic pauses, and natural breath intakes.',
      )
      expect(pauseModule!.avoid).toContain(
        'Trimming rhetorical pauses immediately following major claims, destroying punch and resonance.',
      )
    })

    it('Case 2 (Missing B-Roll): provides explicit guidance to ask user rather than insert irrelevant footage', () => {
      const response = getEditingGuidance({ topics: ['broll', 'missing_footage'] })
      const brollFallback = response.modules.find((m) => m.id === 'broll.missing-footage-policy')
      expect(brollFallback).toBeDefined()
      expect(brollFallback!.principles).toContain(
        'If Hermes determines B-roll would improve an edit but no library candidate meets semantic quality, SCLIP MUST ASK THE USER or retain A-roll.',
      )
      expect(brollFallback!.avoid).toContain(
        'Inserting completely unrelated footage (e.g. office clip for a mountain climbing quote).',
      )
    })

    it('Case 3 (Music Phrasing): provides explicit guidance against mechanical every-beat cutting', () => {
      const response = getEditingGuidance({ topics: ['music', 'phrasing'] })
      const musicModule = response.modules.find((m) => m.id === 'music.musical-phrasing')
      expect(musicModule).toBeDefined()
      expect(musicModule!.principles).toContain(
        'Do not cut on every single musical beat; visual rhythm operates at the phrase and half-phrase level.',
      )
      expect(musicModule!.avoid).toContain(
        'Creating mechanical, strobe-like slideshow edits by cutting on every single 1/4 note beat.',
      )
    })
  })

  describe('Step 10 — Knowledge Payload Budget Measurements', () => {
    it('measures real serialized payload sizes across representative queries', () => {
      const scenarios = [
        {
          name: 'A. Talking-Head Intro Tightening',
          query: { topics: ['hook', 'retakes', 'pause'], contentTypes: ['talking_head', 'youtube_longform'] },
        },
        {
          name: 'B. B-Roll Insertion & Timing',
          query: { topics: ['broll', 'timing'], contentTypes: ['all'] },
        },
        {
          name: 'C. Dialogue Audio Smoothing',
          query: { topics: ['audio', 'crossfade', 'breath'], contentTypes: ['all'] },
        },
        {
          name: 'D. Music Montage Alignment',
          query: { topics: ['music', 'phrasing', 'syncopation'], contentTypes: ['all'] },
        },
        {
          name: 'E. Long-Form Chapter & Pacing Restructure',
          query: { topics: ['long_form', 'pacing_wave', 'tangents'], contentTypes: ['youtube_longform'] },
        },
      ]

      console.log('--- EDITORIAL GUIDANCE PAYLOAD BUDGET ---')
      for (const scenario of scenarios) {
        const response = getEditingGuidance(scenario.query)
        const serialized = JSON.stringify(response)
        const bytes = new TextEncoder().encode(serialized).length
        const approxTokens = Math.round(bytes / 4)

        console.log(`${scenario.name}: ${response.modules.length} modules | ${bytes} bytes (~${approxTokens} tokens)`)

        // Each selective response should remain compact (~300 to 1,500 tokens)
        expect(approxTokens).toBeLessThan(2000)
        expect(response.modules.length).toBeGreaterThan(0)
        expect(response.modules.length).toBeLessThanOrEqual(6)
      }
    })
  })
})
