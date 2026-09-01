/**
 * SCLIP Editorial Knowledge Library (Phase 2A)
 *
 * Grounded, concise, source-traceable craft principles and tunable heuristics
 * for Hermes. This library provides qualitative guidance; it never mutates the
 * timeline, imposes hardcoded aesthetic thresholds, or replaces the planner.
 */

export const EDITORIAL_KNOWLEDGE_VERSION = 'sclip-editorial-knowledge-v1'

export interface SourceReference {
  author: string
  work: string
  year: number
  reference: string
}

export interface TunableHeuristic {
  description: string
  suggestedDefault?: string
  calibrationRequired: true
}

export interface EditorialKnowledgeModule {
  id: string
  title: string
  version: string
  category: 'universal' | 'talking_head' | 'broll' | 'audio' | 'music' | 'long_form' | 'genre'
  topics: string[]
  applicableContentTypes: string[] // ['all'] or specific genres like ['talking_head', 'youtube_longform']
  principles: string[] // Qualitative professional craft principles
  heuristics: TunableHeuristic[] // Explicitly tunable starting points, not rigid laws
  avoid: string[] // Common anti-patterns and over-editing risks
  evidenceNeeded: string[] // Grounded signals Hermes should inspect
  sourceRefs: SourceReference[] // Traceable literature and practitioner citations
}

export interface GetEditingGuidanceOptions {
  topics?: string[]
  contentTypes?: string[]
  segmentGenres?: string[]
  projectIntent?: string
}

export interface EditingGuidanceResponse {
  version: string
  modules: EditorialKnowledgeModule[]
  projectIntent?: string
  contentTypesEvaluated: string[]
  precedenceRules: string[]
  limitations: string[]
}

export const KNOWLEDGE_MODULES: EditorialKnowledgeModule[] = [
  // =========================================================================
  // UNIVERSAL CRAFT PRINCIPLES
  // =========================================================================
  {
    id: 'universal.cut-motivation',
    title: 'Cut Motivation',
    version: '1.0.0',
    category: 'universal',
    topics: ['cut', 'motivation', 'transition', 'story'],
    applicableContentTypes: ['all'],
    principles: [
      'Every cut should be motivated by emotion, story development, visual action, or speech transition.',
      'Never cut purely because a clip reached a duration timer; a cut must shift cognitive focus or reveal new essential information.',
      'If the current shot remains emotionally authentic and informationally active, do not cut away.',
    ],
    heuristics: [
      {
        description: 'Action cuts generally match on subject movement to mask the transition across optic flow processing.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Cutting arbitrarily during active thought without a narrative or speech shift.',
      'Butt-splicing static shots of the same subject without a significant angle or scale shift.',
    ],
    evidenceNeeded: ['speech_gap', 'scene_cut', 'visual_motion', 'subject_gaze'],
    sourceRefs: [
      { author: 'Edward Dmytryk', work: 'On Film Editing', year: 1984, reference: 'Rule 1: Never make a cut without a positive reason.' },
      { author: 'Walter Murch', work: 'In the Blink of an Eye', year: 2001, reference: 'The Rule of Six: Emotion (51%), Story (23%), Rhythm (10%).' },
    ],
  },
  {
    id: 'universal.pacing-and-duration',
    title: 'Pacing and When Not to Cut',
    version: '1.0.0',
    category: 'universal',
    topics: ['pacing', 'pause', 'silence', 'duration', 'rhythm'],
    applicableContentTypes: ['all'],
    principles: [
      'Silence duration alone is an insufficient reason to cut; pauses carry emotional weight, comic timing, rhetorical emphasis, or thought processing.',
      'Pacing should vary dynamically (pacing wave) rather than maintaining an unvarying rapid-fire cadence.',
      'Preserve moments of vulnerability, dramatic realization, or demonstration holds when the audience needs time to absorb context.',
    ],
    heuristics: [
      {
        description: 'Typical speech pause targets range from 0.20s–0.35s for dense explainers to 0.50s–0.80s for narrative pacing, subject to creator preference.',
        suggestedDefault: '0.25s–0.35s',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Stripping every pause automatically with a zero-threshold silence remover.',
      'Creating an exhausting, mechanical staccato rhythm that induces viewer cognitive fatigue.',
    ],
    evidenceNeeded: ['speech_gap', 'vocal_energy', 'acoustic_breath', 'transcript_context'],
    sourceRefs: [
      { author: 'Ken Dancyger', work: 'The Technique of Film and Video Editing', year: 2018, reference: 'Pacing as dramatic structure; compression vs. contemplative holds.' },
      { author: 'Bobbie O’Steen', work: 'The Invisible Cut', year: 2009, reference: 'The power of the held reaction shot and rhythmic breath.' },
    ],
  },
  {
    id: 'universal.dialogue-continuity',
    title: 'Dialogue Continuity',
    version: '1.0.0',
    category: 'universal',
    topics: ['dialogue', 'speech', 'conversation', 'continuity'],
    applicableContentTypes: ['all'],
    principles: [
      'Audio and video cuts should rarely occur at the exact same millisecond; desynchronizing sensory boundaries produces natural speech flow.',
      'Preserve the acoustic envelope of spoken phrases, including pre-speech breaths and natural sentence decay.',
      'Never calculate arbitrary timeline split frames in plans; anchor edits to placement-aware word IDs and acoustic zero-crossings.',
    ],
    heuristics: [
      {
        description: 'Pre-speech padding of 60ms–100ms prevents clipping natural inhalation onsets before vocalization.',
        suggestedDefault: '80ms',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Clipping the leading consonant or breath of an incoming sentence.',
      'Creating hard digital butt-splices that produce phase clicks or abrupt room-tone steps.',
    ],
    evidenceNeeded: ['transcript_word_tokens', 'speech_boundary', 'noise_floor_stability'],
    sourceRefs: [
      { author: 'John Purcell', work: 'Dialogue Editing for Motion Pictures', year: 2014, reference: 'Pre-speech breath preservation and room tone smoothing.' },
      { author: 'Michel Chion', work: 'Audio-Vision', year: 1994, reference: 'Synchresis and temporal desynchronization of sound and image.' },
    ],
  },
  {
    id: 'universal.spatial-continuity',
    title: 'Spatial Continuity and Framing',
    version: '1.0.0',
    category: 'universal',
    topics: ['framing', 'spatial', 'continuity', 'punch_in', 'scale'],
    applicableContentTypes: ['all'],
    principles: [
      'When cutting between successive shots of the same subject, ensure a distinct change in focal length, scale, or angle to avoid perceived transmission glitches.',
      'Gaze transfer (eye-trace) should guide the viewer foveal focus smoothly between outgoing and incoming focal points.',
    ],
    heuristics: [
      {
        description: 'Single-camera punch-ins typically apply 1.10x–1.25x scale centered on subject headroom, bounded by source resolution.',
        suggestedDefault: '1.15x',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Applying punch-ins so subtle (e.g. 1.03x) that they look like accidental visual twitches.',
      'Scaling past source resolution limits where severe pixelation or compression artifacts occur.',
    ],
    evidenceNeeded: ['subject_framing', 'headroom_box', 'source_resolution', 'canvas_dimensions'],
    sourceRefs: [
      { author: 'Roy Thompson & Christopher J. Bowen', work: 'Grammar of the Edit', year: 2009, reference: 'The 30-degree rule and focal length change thresholds.' },
      { author: 'Tim J. Smith', work: 'The Attentional Theory of Cinematic Continuity', year: 2012, reference: 'Eye-tracking and gaze transfer across shot transitions.' },
    ],
  },
  {
    id: 'universal.story-progression',
    title: 'Story Progression and Information Economy',
    version: '1.0.0',
    category: 'universal',
    topics: ['story', 'structure', 'information', 'hook', 'payoff'],
    applicableContentTypes: ['all'],
    principles: [
      'Every segment must advance the narrative premise, answer a raised question, or provide tangible payoff.',
      'Prune redundant restatements of ideas unless repetition serves a deliberate rhetorical, pedagogical, or comedic purpose.',
      'Build the primary story cut and speech flow before adding decorative overlay layers or audio sweetening.',
    ],
    heuristics: [
      {
        description: 'Information density can be increased by removing circular preambles, but critical explanatory premises must remain intact.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Deleting essential context or steps needed for comprehension in the pursuit of pure brevity.',
      'Structuring edits around visual gimmicks before narrative coherence is secured.',
    ],
    evidenceNeeded: ['transcript_summary', 'chapter_structure', 'topic_transitions'],
    sourceRefs: [
      { author: 'Karel Reisz & Gavin Millar', work: 'The Technique of Film Editing', year: 2009, reference: 'Narrative economy and dramatic construction.' },
    ],
  },

  // =========================================================================
  // TALKING HEAD & EXPLAINER GRAMMAR
  // =========================================================================
  {
    id: 'talking_head.retakes-and-false-starts',
    title: 'Talking Head: Retakes and False Starts',
    version: '1.0.0',
    category: 'talking_head',
    topics: ['retakes', 'false_starts', 'mistakes', 'talking_head'],
    applicableContentTypes: ['talking_head', 'youtube_longform', 'tutorial', 'interview_podcast'],
    principles: [
      'When a speaker repeats a sentence or phrase, evaluate all attempts; the final take is often cleanest, but an earlier take may contain superior emotional energy.',
      'Always confirm candidate takes against grounded transcript word IDs before proposing speech removal.',
      'Apply appropriate visual treatment (punch-in or B-roll) over retake seams if head position shifts noticeably.',
    ],
    heuristics: [
      {
        description: 'Adjacent segments with high text similarity (>80%) indicate a retake cluster; rank by completeness and vocal energy.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Butt-splicing two halves of different takes with mismatched pitch or room acoustic levels.',
      'Silently deleting spoken content without generating a reviewable EditPlan.',
    ],
    evidenceNeeded: ['retake_clusters', 'word_ids', 'vocal_energy', 'pitch_stability'],
    sourceRefs: [
      { author: 'John Purcell', work: 'Dialogue Editing for Motion Pictures', year: 2014, reference: 'Comping multiple takes and dialogue matching.' },
    ],
  },
  {
    id: 'talking_head.filler-and-hesitation',
    title: 'Talking Head: Filler Words and Hesitation',
    version: '1.0.0',
    category: 'talking_head',
    topics: ['filler', 'hesitation', 'speech_cleanup', 'talking_head'],
    applicableContentTypes: ['talking_head', 'youtube_longform', 'short_form', 'tutorial'],
    principles: [
      'Remove hesitation sounds ("um", "uh", "erm") when they represent dead cognitive stalling.',
      'Preserve natural conversational fillers when they communicate genuine thought, humor, empathy, or creator personality.',
      'Verify transcript word confidence before removing filler tokens to avoid cutting real words misclassified by ASR.',
    ],
    heuristics: [
      {
        description: 'Low-confidence transcript words (<0.65) should be verified or skipped rather than cut automatically.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Over-sanitizing speech to the point where the delivery sounds synthetic or robotic.',
      'Chopping into adjacent word consonants when removing isolated filler tokens.',
    ],
    evidenceNeeded: ['filler_tokens', 'word_confidence', 'speech_boundaries'],
    sourceRefs: [
      { author: 'Paddy Galloway & Hayden Hillier-Smith', work: 'Creator Editing Masterclasses', year: 2023, reference: 'Natural speech pacing vs. robotic over-cutting.' },
    ],
  },
  {
    id: 'talking_head.pause-judgement',
    title: 'Talking Head: Pause Judgement',
    version: '1.0.0',
    category: 'talking_head',
    topics: ['pause', 'pacing', 'silence', 'talking_head'],
    applicableContentTypes: ['talking_head', 'youtube_longform', 'short_form', 'interview_podcast'],
    principles: [
      'Distinguish dead hesitations from rhetorical emphasis pauses, comedic pauses, and natural breath intakes.',
      'Tighten dead gaps between complete thoughts while preserving rhythmic breathing space.',
      'Respect creator pacing preferences when tightened pause targets have been confirmed.',
    ],
    heuristics: [
      {
        description: 'Dead silence gaps (>0.8s) between unrelated clauses can typically be tightened to 0.20s–0.35s in fast explainer formats.',
        suggestedDefault: '0.25s',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Trimming rhetorical pauses immediately following major claims, destroying punch and resonance.',
      'Creating zero-millisecond pause transitions between separate sentences.',
    ],
    evidenceNeeded: ['speech_gap', 'acoustic_breath', 'vocal_energy', 'creator_pacing_style'],
    sourceRefs: [
      { author: 'Ken Dancyger', work: 'The Technique of Film and Video Editing', year: 2018, reference: 'Rhythm in dialogue delivery.' },
    ],
  },
  {
    id: 'talking_head.motivated-punch-ins',
    title: 'Talking Head: Motivated Punch-Ins',
    version: '1.0.0',
    category: 'talking_head',
    topics: ['punch_in', 'framing', 'scale', 'talking_head'],
    applicableContentTypes: ['talking_head', 'youtube_longform', 'short_form'],
    principles: [
      'Apply scale punch-ins at topic shifts, key thesis emphasis, or over retake jump-cut seams to simulate a second camera angle.',
      'Do not apply punch-ins on arbitrary time intervals without semantic or continuity motivation.',
      'Ensure the crop maintains natural headroom and respects face bounding box centering.',
    ],
    heuristics: [
      {
        description: 'Punch-in scaling typically uses 1.10x–1.20x; return to wide (1.00x) after 3–8 seconds or upon the next topic change.',
        suggestedDefault: '1.15x',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Rapidly oscillating between wide and tight every 2 seconds.',
      'Punching in so deeply that the speaker’s chin or forehead is cropped awkwardly.',
    ],
    evidenceNeeded: ['topic_transition', 'retake_seam', 'face_bounding_box', 'source_resolution'],
    sourceRefs: [
      { author: 'Roy Thompson & Christopher J. Bowen', work: 'Grammar of the Edit', year: 2009, reference: 'Shot scale matching and visual emphasis.' },
    ],
  },
  {
    id: 'talking_head.hook-and-intro',
    title: 'Talking Head: Hook and Introduction',
    version: '1.0.0',
    category: 'talking_head',
    topics: ['hook', 'intro', 'retention', 'talking_head', 'youtube_longform'],
    applicableContentTypes: ['talking_head', 'youtube_longform', 'short_form'],
    principles: [
      'Deliver the primary premise, core stake, or promised transformation in the opening seconds.',
      'Eliminate self-indulgent preambles, channel greetings, or mic checks before the core topic is established.',
      'Hook candidates require editorial validation; never fabricate claims or misrepresent the video content.',
    ],
    heuristics: [
      {
        description: 'Short-form hooks must arrest attention within the first 1.0s–1.5s; YouTube long-form hooks typically deliver core premise within 15s–30s.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Opening with generic greetings ("Hey guys welcome back") before the topic hook.',
      'Manufactured clickbait hooks that have no payoff in the body footage.',
    ],
    evidenceNeeded: ['hook_candidates', 'opening_segments', 'transcript_summary'],
    sourceRefs: [
      { author: 'Paddy Galloway & Colin and Samir', work: 'YouTube Retention Analysis', year: 2023, reference: 'Opening retention curves and premise delivery.' },
    ],
  },

  // =========================================================================
  // B-ROLL EDITORIAL GRAMMAR
  // =========================================================================
  {
    id: 'broll.motivation-categories',
    title: 'B-Roll: Motivation Categories',
    version: '1.0.0',
    category: 'broll',
    topics: ['broll', 'cutaway', 'visual_variety', 'coverage'],
    applicableContentTypes: ['all'],
    principles: [
      'B-roll must serve a concrete purpose: illustrative (showing the object), contextual (setting the scene), kinetic (pacing relief), or continuity (hiding a jump cut).',
      'Never insert random, unmotivated B-roll solely to satisfy an arbitrary visual turnover quota.',
      'Ensure B-roll shot motion and subject action complement rather than distract from spoken dialogue.',
    ],
    heuristics: [
      {
        description: 'B-roll frequency depends heavily on creator style and format, varying from sparse narrative holds to frequent explainer cutaways.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Inserting decorative B-roll that conflicts with or contradicts what the speaker is explaining.',
      'Covering expressive, emotionally vital on-camera performance moments with generic footage.',
    ],
    evidenceNeeded: ['dialogue_intent', 'broll_candidates', 'visual_moments', 'creator_style'],
    sourceRefs: [
      { author: 'Edward Dmytryk', work: 'On Film Editing', year: 1984, reference: 'Cutaway motivation and visual relevance.' },
    ],
  },
  {
    id: 'broll.timing-and-readability',
    title: 'B-Roll: Timing and Readability',
    version: '1.0.0',
    category: 'broll',
    topics: ['broll', 'timing', 'readability', 'pre_roll'],
    applicableContentTypes: ['all'],
    principles: [
      'Illustrative B-roll may enter slightly before, on, or shortly after the relevant concept depending on sentence structure and shot readability.',
      'Allow sufficient duration for the viewer to decode the image; shots with complex text or fine detail require longer holds than simple graphic shapes.',
    ],
    heuristics: [
      {
        description: 'Typical illustrative B-roll pre-roll is 0.2s–0.4s ahead of the spoken noun; minimum readable duration is typically 1.2s–1.5s.',
        suggestedDefault: '0.3s lead, 2.5s hold',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Holding B-roll so briefly (<1.0s) that the viewer perceives a flashing glitch rather than an image.',
      'Placing B-roll so late after the spoken noun that the association is lost.',
    ],
    evidenceNeeded: ['word_timestamps', 'broll_shot_complexity', 'musical_cadence'],
    sourceRefs: [
      { author: 'Tim J. Smith', work: 'Attentional Theory of Cinematic Continuity', year: 2012, reference: 'Visual comprehension latency vs. auditory decoding.' },
    ],
  },
  {
    id: 'broll.missing-footage-policy',
    title: 'B-Roll: Missing Footage and User Fallback Policy',
    version: '1.0.0',
    category: 'broll',
    topics: ['broll', 'fallback', 'missing_footage', 'ask_user'],
    applicableContentTypes: ['all'],
    principles: [
      'If Hermes determines B-roll would improve an edit but no library candidate meets semantic quality, SCLIP MUST ASK THE USER or retain A-roll.',
      'Never insert an irrelevant or low-quality clip just to fill a visual gap.',
      'Propose specific missing asset descriptions when prompting the user to import footage.',
    ],
    heuristics: [
      {
        description: 'Candidate confidence should be evaluated against calibrated relative score distributions, not a rigid single float cutoff.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Inserting completely unrelated footage (e.g. office clip for a mountain climbing quote).',
      'Silently suppressing a valuable B-roll opportunity without informing the user.',
    ],
    evidenceNeeded: ['broll_retrieval_scores', 'score_gap', 'library_asset_inventory'],
    sourceRefs: [
      { author: 'SCLIP Architecture Specification', work: 'Anti-Hallucination Fallback Contract', year: 2026, reference: 'Deterministic Ask-User rule on low confidence.' },
    ],
  },

  // =========================================================================
  // AUDIO & DIALOGUE EDITORIAL GRAMMAR
  // =========================================================================
  {
    id: 'audio.speech-boundary-continuity',
    title: 'Audio: Speech Boundary Continuity',
    version: '1.0.0',
    category: 'audio',
    topics: ['audio', 'crossfade', 'zero_crossing', 'clicks'],
    applicableContentTypes: ['all'],
    principles: [
      'Detect acoustic discontinuity risks (zero-crossing steps, clipped breaths, noise jumps) and apply appropriate contextual repairs.',
      'Every digital butt-splice on active waveforms must be protected against phase clicks.',
      'Preserve natural speech cadence without abrupt micro-gaps between connected words.',
    ],
    heuristics: [
      {
        description: 'Equal-power crossfades of 10ms–25ms generally eliminate zero-crossing clicks without audible vocal smearing.',
        suggestedDefault: '15ms',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Hard cut splices across high-amplitude audio waveforms.',
      'Applying overly long crossfades (>50ms) across speech that cause double-consonant flanging.',
    ],
    evidenceNeeded: ['waveform_zero_crossings', 'audio_splice_points', 'noise_floor_delta'],
    sourceRefs: [
      { author: 'John Purcell', work: 'Dialogue Editing for Motion Pictures', year: 2014, reference: 'Equal-power crossfades and phase continuity.' },
    ],
  },
  {
    id: 'audio.breaths-and-room-tone',
    title: 'Audio: Breaths and Room Tone',
    version: '1.0.0',
    category: 'audio',
    topics: ['audio', 'breath', 'room_tone', 'ambience'],
    applicableContentTypes: ['all'],
    principles: [
      'Natural breathing is essential to human speech cadence; retain preparatory breaths before major thoughts.',
      'When joining clips recorded in different ambient environments, smooth the noise floor transition with room tone or gentle EQ matching.',
      'Remove gasps or hyperventilating breaths, but preserve quiet, natural inhalations.',
    ],
    heuristics: [
      {
        description: 'Pre-speech breath padding of 60ms–120ms preserves natural inhalation attacks.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Chopping breaths in half, creating sharp gasp artifacts.',
      'Allowing sudden drops into dead digital silence between dialogue lines.',
    ],
    evidenceNeeded: ['acoustic_breath_detection', 'noise_floor_level', 'ambient_room_tone'],
    sourceRefs: [
      { author: 'David Sonnenschein', work: 'Sound Design', year: 2001, reference: 'Psychological reality of room tone and breathing.' },
    ],
  },
  {
    id: 'audio.j-l-cuts',
    title: 'Audio: J-Cuts and L-Cuts (Split Edits)',
    version: '1.0.0',
    category: 'audio',
    topics: ['audio', 'j_cut', 'l_cut', 'split_edit', 'conversation'],
    applicableContentTypes: ['interview_podcast', 'documentary', 'vlog', 'youtube_longform'],
    principles: [
      'Use J-cuts (audio leading picture) to prepare the viewer ear for an incoming speaker or scene transition.',
      'Use L-cuts (audio trailing picture) to display listener reactions or environmental context while the previous speaker completes a sentence.',
      'Split edits significantly reduce the perceived abruptness of visual cuts.',
    ],
    heuristics: [
      {
        description: 'J-cut audio lead times typically range from 0.3s to 1.2s depending on conversational pace and scene mood.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Strictly synchronizing every audio cut with every visual cut across multi-person conversations.',
      'Cutting audio so early that the incoming speaker talks over a crucial punchline.',
    ],
    evidenceNeeded: ['speaker_switches', 'reaction_frames', 'dialogue_overlap'],
    sourceRefs: [
      { author: 'Michel Chion', work: 'Audio-Vision', year: 1994, reference: 'Sound bridges and audio-visual counterpoint.' },
    ],
  },

  // =========================================================================
  // MUSIC EDITORIAL GRAMMAR
  // =========================================================================
  {
    id: 'music.musical-phrasing',
    title: 'Music: Musical Phrasing and Cadence',
    version: '1.0.0',
    category: 'music',
    topics: ['music', 'phrasing', 'downbeat', 'rhythm', 'cadence'],
    applicableContentTypes: ['all'],
    principles: [
      'Align major visual shifts, scene transitions, and hook resolutions with musical phrases (4-bar or 8-bar cycles) or downbeats (Bar 1).',
      'Do not cut on every single musical beat; visual rhythm operates at the phrase and half-phrase level.',
      'Use musical builds, drops, and cadence shifts to motivate story energy transitions.',
    ],
    heuristics: [
      {
        description: 'Downbeat alignment serves as a strong default for major section shifts; internal cuts can vary between 2-bar and 4-bar holds.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Creating mechanical, strobe-like slideshow edits by cutting on every single 1/4 note beat.',
      'Ignoring musical cadence endings, cutting mid-chord across melodic phrases.',
    ],
    evidenceNeeded: ['music_beat_grid', 'downbeat_markers', 'phrase_boundaries', 'musical_energy'],
    sourceRefs: [
      { author: 'Danijela Kulezic-Wilson', work: 'The Musicality of Narrative Film', year: 2015, reference: 'Temporal counterpoint and musical phrasing.' },
    ],
  },
  {
    id: 'music.dialogue-intelligibility-ducking',
    title: 'Music: Dialogue Intelligibility and Ducking',
    version: '1.0.0',
    category: 'music',
    topics: ['music', 'ducking', 'loudness', 'speech_clarity'],
    applicableContentTypes: ['all'],
    principles: [
      'Music must never mask speech intelligibility; duck background tracks dynamically whenever dialogue is present.',
      'Allow music to swell during pauses, montages, and visual action beats to carry narrative momentum.',
    ],
    heuristics: [
      {
        description: 'Typical speech ducking ranges from -10dB to -18dB with fast attack (60ms–120ms) and smooth musical release (300ms–600ms).',
        suggestedDefault: '-12dB',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Pumping music levels erratically across short micro-pauses.',
      'Burying low-energy vocal delivery beneath dense musical instrumentation.',
    ],
    evidenceNeeded: ['dialogue_presence', 'vocal_frequency_band', 'music_track_volume'],
    sourceRefs: [
      { author: 'David Sonnenschein', work: 'Sound Design', year: 2001, reference: 'Frequency masking and dialogue clarity.' },
    ],
  },
  {
    id: 'music.beat-alignment-vs-off-beat',
    title: 'Music: Beat Alignment vs. Deliberate Off-Beat Cutting',
    version: '1.0.0',
    category: 'music',
    topics: ['music', 'syncopation', 'off_beat', 'anticipation'],
    applicableContentTypes: ['vlog', 'sports', 'gaming', 'short_form', 'youtube_longform'],
    principles: [
      'Cutting slightly ahead of a beat (1/8th note syncopation) creates forward drive, kinetic energy, and anticipation.',
      'Sudden cessation of music (a "music drop") immediately prior to a punchline or dramatic reveal amplifies impact tenfold.',
      'Off-beat cutting prevents rhythmic predictability and keeps the audience visually engaged.',
    ],
    heuristics: [
      {
        description: 'Syncopated cuts are typically placed 80ms–150ms ahead of major downbeat transients in high-energy sequences.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Predictable cutting patterns where every single edit lands on the exact same metric subdivision.',
      'Letting high-energy music drone continuously through dramatic dialogue reveals.',
    ],
    evidenceNeeded: ['music_transients', 'beat_subdivisions', 'scene_climax_points'],
    sourceRefs: [
      { author: 'Nicholas Cook', work: 'Analysing Musical Multimedia', year: 1998, reference: 'Musical syncopation and visual counterpoint.' },
    ],
  },

  // =========================================================================
  // LONG-FORM EDITORIAL GRAMMAR
  // =========================================================================
  {
    id: 'long_form.pacing-variation-wave',
    title: 'Long-Form: Pacing Variation Wave',
    version: '1.0.0',
    category: 'long_form',
    topics: ['long_form', 'pacing_wave', 'retention', 'fatigue'],
    applicableContentTypes: ['youtube_longform', 'documentary', 'interview_podcast'],
    principles: [
      'Long-form videos require pacing waves: alternating high-density explainer blocks with slower, contemplative or narrative reset beats.',
      'Constant maximum-speed pacing exhausts viewer cognitive bandwidth after 4–6 minutes.',
      'Introduce visual or auditory pattern interrupts every 30–60 seconds to refresh attention.',
    ],
    heuristics: [
      {
        description: 'Pacing waves typically cycle every 2–4 minutes between dense information delivery and grounded reflective holds.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Maintaining an unchanging rapid jump-cut pace across a 40-minute video.',
      'Allowing pacing to decay into a monotonous, unvaried drone.',
    ],
    evidenceNeeded: ['project_duration', 'speech_density_timeline', 'chapter_boundaries'],
    sourceRefs: [
      { author: 'Ken Dancyger', work: 'The Technique of Film and Video Editing', year: 2018, reference: 'Pacing cycles and narrative endurance.' },
      { author: 'Paddy Galloway', work: 'YouTube Long-Form Retention Analysis', year: 2024, reference: 'Pattern interrupts and attention wave cycles.' },
    ],
  },
  {
    id: 'long_form.repetition-and-tangents',
    title: 'Long-Form: Repetition and Tangent Judgement',
    version: '1.0.0',
    category: 'long_form',
    topics: ['long_form', 'tangent', 'repetition', 'structure'],
    applicableContentTypes: ['youtube_longform', 'interview_podcast', 'documentary'],
    principles: [
      'Identify and prune circular arguments or unmotivated tangents that drift away from the central video thesis.',
      'Distinguish deliberate structural callbacks and pedagogical reinforcement from accidental rambling.',
      'Cross-window reasoning must evaluate whether a concept discussed at minute 15 repeats unnecessarily at minute 35.',
    ],
    heuristics: [
      {
        description: 'Semantic topic similarity across distant chapters can signal redundant loops; Hermes should propose restructuring or trimming.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Trimming personal anecdotes that establish crucial audience connection or thematic heart.',
      'Deleting callbacks that provide essential narrative payoff.',
    ],
    evidenceNeeded: ['chapter_topic_map', 'cross_window_semantics', 'narrative_arc'],
    sourceRefs: [
      { author: 'Karel Reisz & Gavin Millar', work: 'The Technique of Film Editing', year: 2009, reference: 'Thematic unity and sequence construction.' },
    ],
  },
  {
    id: 'long_form.chapter-topic-progression',
    title: 'Long-Form: Chapter and Topic Progression',
    version: '1.0.0',
    category: 'long_form',
    topics: ['long_form', 'chapters', 'progression', 'milestones'],
    applicableContentTypes: ['youtube_longform', 'tutorial', 'documentary'],
    principles: [
      'Organize long projects into clear narrative or conceptual chapters with distinct setups, developments, and payoffs.',
      'Mark chapter boundaries with subtle visual resets, title cards, or audio cadence changes.',
      'Ensure each chapter delivers on its promised premise before transitioning to the next topic.',
    ],
    heuristics: [
      {
        description: 'YouTube long-form videos typically benefit from chapter segments spanning 2 to 6 minutes each.',
        calibrationRequired: true,
      },
    ],
    avoid: [
      'Abruptly abandoning a topic midway without resolution or transition.',
      'Creating chapters so short (<30s) that the structure feels fragmented.',
    ],
    evidenceNeeded: ['project_summary', 'topic_transitions', 'chapter_markers'],
    sourceRefs: [
      { author: 'Ken Dancyger', work: 'The Technique of Film and Video Editing', year: 2018, reference: 'Act structures in non-fiction and documentary.' },
    ],
  },
]

/**
 * Selectively retrieve relevant editorial guidance modules for Hermes.
 * This function performs deterministic filtering based on requested topics,
 * content types, segment genres, and project intent.
 */
export function getEditingGuidance(options: GetEditingGuidanceOptions | unknown): EditingGuidanceResponse {
  const opts = (options && typeof options === 'object' ? options : {}) as GetEditingGuidanceOptions
  const requestedTopics = Array.isArray(opts.topics)
    ? new Set(opts.topics.map((t) => String(t).trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')).filter(Boolean))
    : new Set<string>()

  const contentTypes = Array.isArray(opts.contentTypes)
    ? opts.contentTypes.map((c) => String(c).trim().toLowerCase())
    : opts.segmentGenres && Array.isArray(opts.segmentGenres)
      ? opts.segmentGenres.map((g) => String(g).trim().toLowerCase())
      : []

  const contentSet = new Set(contentTypes)

  // Filter modules by topic and content type
  const matchedModules = KNOWLEDGE_MODULES.filter((module) => {
    // Topic matching
    const matchesTopic = requestedTopics.size === 0 || module.topics.some((topic) =>
      requestedTopics.has(topic) ||
      requestedTopics.has(topic.replaceAll('_', '-')) ||
      Array.from(requestedTopics).some((req) => topic.includes(req) || req.includes(topic)),
    ) || requestedTopics.has(module.id) || requestedTopics.has(module.category)

    if (!matchesTopic) return false

    // Content type matching
    if (contentSet.size === 0) return true
    if (module.applicableContentTypes.includes('all')) return true
    return module.applicableContentTypes.some((type) => contentSet.has(type))
  })

  // Precedence rules explain the hierarchy to Hermes
  const precedenceRules = [
    '1. HARD SAFETY: Machine validity, timeline bounds, and revision integrity always govern execution.',
    '2. USER REQUEST: Explicit user prompt instructions override default craft principles.',
    '3. PROJECT INTENT: Stated project goals (e.g. "cinematic mood") shape genre defaults.',
    '4. CREATOR STYLE: Confirmed creator preferences adapt pacing and framing defaults.',
    '5. CONTENT GRAMMAR: Genre conventions guide density, hook timing, and transition frequency.',
    '6. CRAFT PRINCIPLES: Universal editing theory (Murch, Dmytryk, Purcell) serves as foundational reasoning baseline.',
    '7. TUNABLE HEURISTICS: Numeric defaults (e.g. ducking dB, punch-in scale) are starting points requiring contextual calibration.',
  ]

  const limitations = matchedModules.length
    ? ['Guidance provides qualitative craft principles and tunable starting heuristics; it is not an automatic edit instruction or rigid threshold engine.']
    : ['No matching guidance module found. General craft principles and hard constraints remain active.']

  return {
    version: EDITORIAL_KNOWLEDGE_VERSION,
    modules: matchedModules,
    projectIntent: opts.projectIntent,
    contentTypesEvaluated: contentTypes.length ? contentTypes : ['all'],
    precedenceRules,
    limitations,
  }
}
