// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import {
  getVideoSyncTargetContext,
  isVideoSyncTargetDiscontinuity,
  planLayoutVideoSync,
  planPausedVideoFrameSync,
  planPlayingVideoDriftCorrection,
  planPlayingVideoInitialSync,
  planPremountedVideoSync,
  planStalledVideoRecovery,
  planVideoFrameCallbackCorrection,
  shouldUpdateVideoPlaybackRate,
  shouldReactOwnPlaybackRate,
} from './video-sync-plan'

describe('shouldReactOwnPlaybackRate', () => {
  it('lets RVFC own playback rate during active playback', () => {
    expect(
      shouldReactOwnPlaybackRate({
        isPlaying: true,
        supportsRequestVideoFrameCallback: true,
        sharedTransitionSync: false,
      }),
    ).toBe(false)
  })

  it('keeps React in control when playback is paused', () => {
    expect(
      shouldReactOwnPlaybackRate({
        isPlaying: false,
        supportsRequestVideoFrameCallback: true,
        sharedTransitionSync: false,
      }),
    ).toBe(true)
  })

  it('lets RVFC own playback rate during shared transition sync with RVFC support', () => {
    expect(
      shouldReactOwnPlaybackRate({
        isPlaying: true,
        supportsRequestVideoFrameCallback: true,
        sharedTransitionSync: true,
      }),
    ).toBe(false)
  })

  it('keeps React in control during shared transition sync without RVFC', () => {
    expect(
      shouldReactOwnPlaybackRate({
        isPlaying: true,
        supportsRequestVideoFrameCallback: false,
        sharedTransitionSync: false,
      }),
    ).toBe(true)
  })
})

describe('getVideoSyncTargetContext', () => {
  it('derives premount target times from trim start', () => {
    expect(
      getVideoSyncTargetContext({
        frame: 10,
        sequenceFrameOffset: 20,
        safeTrimBefore: 90,
        sourceFps: 30,
        targetTime: 5,
        readyState: 4,
        videoDuration: 12,
        currentTime: 0,
      }),
    ).toMatchObject({
      relativeFrame: -10,
      isPremounted: true,
      canSeek: true,
      effectiveTargetTime: 3,
      clampedTargetTime: 3,
    })
  })
})

describe('planPremountedVideoSync', () => {
  it('keeps transition-held videos untouched during premount', () => {
    expect(
      planPremountedVideoSync({
        isTransitionHeld: true,
        canSeek: true,
        currentTime: 0,
        targetTime: 2,
        seekToleranceSeconds: 0.016,
      }),
    ).toEqual({
      shouldPause: false,
      seekTo: null,
    })
  })
})

describe('planLayoutVideoSync', () => {
  it('forces a hard sync on the first ready layout pass', () => {
    expect(
      planLayoutVideoSync({
        isPremounted: false,
        isTransitionHeld: false,
        canSeek: true,
        currentTime: 1,
        targetTime: 2,
        isPlaying: true,
        needsInitialSync: true,
      }),
    ).toEqual({
      shouldPause: false,
      seekTo: 2,
      shouldMarkInitialSyncComplete: true,
    })
  })
})

describe('planPlayingVideoInitialSync', () => {
  it('marks initial sync complete even when the video is already in place', () => {
    expect(
      planPlayingVideoInitialSync({
        needsInitialSync: true,
        canSeek: true,
        currentTime: 2,
        targetTime: 2,
      }),
    ).toEqual({
      seekTo: null,
      shouldMarkInitialSyncComplete: true,
      shouldUpdateLastSyncTime: true,
    })
  })
})

describe('planPlayingVideoDriftCorrection', () => {
  it('suppresses hard seek while seeking is in flight', () => {
    expect(
      planPlayingVideoDriftCorrection({
        canSeek: true,
        currentTime: 1,
        targetTime: 1.8,
        lastSyncTimeMs: 0,
        nowMs: 1000,
        seeking: true,
      }),
    ).toEqual({
      shouldPause: false,
      seekTo: null,
    })
  })

  it('suppresses hard seek during post-seek settling grace window', () => {
    expect(
      planPlayingVideoDriftCorrection({
        canSeek: true,
        currentTime: 1,
        targetTime: 1.8,
        lastSyncTimeMs: 0,
        nowMs: 1000,
        isPostSeekSettling: true,
      }),
    ).toEqual({
      shouldPause: false,
      seekTo: null,
    })
  })

  it('hard seeks immediately on real transport discontinuity', () => {
    expect(
      planPlayingVideoDriftCorrection({
        canSeek: true,
        currentTime: 1,
        targetTime: 30,
        lastSyncTimeMs: 0,
        nowMs: 100,
        targetDiscontinuity: true,
      }),
    ).toEqual({
      shouldPause: false,
      seekTo: 30,
    })
  })

  it('suppresses hard seek for continuous playback drift', () => {
    expect(
      planPlayingVideoDriftCorrection({
        canSeek: true,
        currentTime: 1,
        targetTime: 1.8,
        lastSyncTimeMs: 0,
        nowMs: 1000,
      }),
    ).toEqual({
      shouldPause: false,
      seekTo: null,
    })
  })
})

describe('planStalledVideoRecovery', () => {
  const stableInput = {
    canSeek: true,
    isPlaying: true,
    seeking: false,
    isPostSeekSettling: false,
    isRecoveryCooldownActive: false,
    elapsedMs: 500,
    previousTargetTime: 10,
    targetTime: 10.5,
    previousCurrentTime: 9.9,
    currentTime: 9.9,
  }

  it('keeps small drift on the normal rate-correction path', () => {
    expect(
      planStalledVideoRecovery({
        ...stableInput,
        previousCurrentTime: 10.45,
        currentTime: 10.48,
      }),
    ).toEqual({ shouldPause: false, seekTo: null, shouldRecover: false })
  })

  it('does not seek large drift while the video clock is still progressing', () => {
    expect(
      planStalledVideoRecovery({
        ...stableInput,
        previousCurrentTime: 9,
        currentTime: 9.45,
      }),
    ).toEqual({ shouldPause: false, seekTo: null, shouldRecover: false })
  })

  it('recovers a stalled clock to the mapped source target exactly once', () => {
    expect(planStalledVideoRecovery(stableInput)).toEqual({
      shouldPause: false,
      seekTo: 10.5,
      shouldRecover: true,
    })
  })

  it('suppresses a follow-up recovery during post-seek grace or cooldown', () => {
    expect(
      planStalledVideoRecovery({ ...stableInput, isPostSeekSettling: true }),
    ).toEqual({ shouldPause: false, seekTo: null, shouldRecover: false })
    expect(
      planStalledVideoRecovery({ ...stableInput, isRecoveryCooldownActive: true }),
    ).toEqual({ shouldPause: false, seekTo: null, shouldRecover: false })
  })

  it('does not treat an isolated short sample as a video stall', () => {
    expect(planStalledVideoRecovery({ ...stableInput, elapsedMs: 125 })).toEqual({
      shouldPause: false,
      seekTo: null,
      shouldRecover: false,
    })
  })
})

describe('planPausedVideoFrameSync', () => {
  it('seeks paused video only when the frame changed and drift is meaningful', () => {
    expect(
      planPausedVideoFrameSync({
        frameChanged: true,
        canSeek: true,
        currentTime: 1,
        targetTime: 1.1,
      }),
    ).toEqual({
      shouldPause: false,
      seekTo: 1.1,
    })
  })
})

describe('planVideoFrameCallbackCorrection', () => {
  it('returns nominal_rate while seeking is in flight', () => {
    const plan = planVideoFrameCallbackCorrection({
      currentTime: 1.5,
      targetTime: 1,
      nominalRate: 1,
      readyState: 4,
      seeking: true,
    })
    expect(plan).toEqual({
      kind: 'nominal_rate',
      playbackRate: 1,
    })
  })

  it('applies gentle rate adjustment during post-seek settling without hard seek', () => {
    const plan = planVideoFrameCallbackCorrection({
      currentTime: 1.2,
      targetTime: 1,
      nominalRate: 1,
      readyState: 4,
      isPostSeekSettling: true,
    })
    expect(plan.kind).toBe('adjust_rate')
    if (plan.kind === 'adjust_rate') {
      expect(plan.playbackRate).toBeLessThan(1)
      expect(plan.playbackRate).toBeGreaterThanOrEqual(0.92)
    }
  })

  it('rate-corrects moderate drift instead of repeatedly re-decoding a GOP', () => {
    const plan = planVideoFrameCallbackCorrection({
      currentTime: 1.2,
      targetTime: 1,
      nominalRate: 1,
      readyState: 4,
    })

    expect(plan.kind).toBe('adjust_rate')
    if (plan.kind !== 'adjust_rate') {
      throw new Error('Expected rate adjustment plan')
    }
    expect(plan.playbackRate).toBeLessThan(1)
  })

  it('adjusts playback rate for small drift', () => {
    const plan = planVideoFrameCallbackCorrection({
      currentTime: 1.05,
      targetTime: 1,
      nominalRate: 1,
      readyState: 4,
    })

    expect(plan.kind).toBe('adjust_rate')
    if (plan.kind !== 'adjust_rate') {
      throw new Error('Expected rate adjustment plan')
    }
    expect(plan.playbackRate).toBeLessThan(1)
  })

  it('returns nominal_rate when drift is negligible (<= 20ms)', () => {
    const plan = planVideoFrameCallbackCorrection({
      currentTime: 1.008,
      targetTime: 1,
      nominalRate: 1,
      readyState: 4,
    })

    expect(plan.kind).toBe('nominal_rate')
    if (plan.kind !== 'nominal_rate') {
      throw new Error('Expected nominal_rate plan')
    }
    expect(plan.playbackRate).toBe(1)
  })

  it('rate-corrects instead of re-seeking continuous-playback decoder drift', () => {
    const plan = planVideoFrameCallbackCorrection({
      currentTime: 1.3,
      targetTime: 1,
      nominalRate: 1,
      readyState: 4,
      targetDiscontinuity: false,
    })

    expect(plan.kind).toBe('adjust_rate')
    if (plan.kind !== 'adjust_rate') {
      throw new Error('Expected rate adjustment plan')
    }
    // video ahead of target -> slow down
    expect(plan.playbackRate).toBeLessThan(1)
  })

  it('hard seeks when drift follows a real transport discontinuity', () => {
    expect(
      planVideoFrameCallbackCorrection({
        currentTime: 2,
        targetTime: 1,
        nominalRate: 1,
        readyState: 4,
        targetDiscontinuity: true,
      }),
    ).toEqual({
      kind: 'seek',
      seekTo: 1,
      playbackRate: 1,
      shouldUpdateLastSyncTime: true,
    })
  })

  it('rate-corrects large drift during continuous playback rather than restarting GOP decode', () => {
    const plan = planVideoFrameCallbackCorrection({
      currentTime: 0,
      targetTime: 1.5,
      nominalRate: 1,
      readyState: 4,
    })
    expect(plan.kind).toBe('adjust_rate')
    if (plan.kind === 'adjust_rate') {
      expect(plan.playbackRate).toBeGreaterThan(1)
      expect(plan.playbackRate).toBeLessThanOrEqual(1.15)
    }
  })
})

describe('isVideoSyncTargetDiscontinuity', () => {
  it('distinguishes delayed frame delivery from a transport seek', () => {
    expect(
      isVideoSyncTargetDiscontinuity({
        previousTargetTime: 10,
        targetTime: 10.5,
        elapsedMs: 500,
        nominalRate: 1,
      }),
    ).toBe(false)
    expect(
      isVideoSyncTargetDiscontinuity({
        previousTargetTime: 10,
        targetTime: 25,
        elapsedMs: 33,
        nominalRate: 1,
      }),
    ).toBe(true)
  })
})

describe('shouldUpdateVideoPlaybackRate', () => {
  it('skips tiny repeated playback-rate writes from frame callbacks', () => {
    expect(shouldUpdateVideoPlaybackRate(1, 1.003)).toBe(false)
    expect(shouldUpdateVideoPlaybackRate(1, 1.01)).toBe(false)
    expect(shouldUpdateVideoPlaybackRate(1, 1.02)).toBe(true)
  })
})
