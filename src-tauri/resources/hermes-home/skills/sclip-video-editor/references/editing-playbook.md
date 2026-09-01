# SCLIP Editing Playbook

Use this as a conservative shared baseline. It is not a substitute for a
user's explicit style, brand rules, or editorial judgement.

## Order of work

1. Inspect the live timeline, imported media, transcript, and requested output.
2. Build or repair the story cut before decoration: choose the strongest hook,
   remove repeated takes and approved dead air, then establish a clear ending.
3. Keep dialogue/video continuity intact while transcript-based cuts split or
   remove sections. Do not use caption text as a proxy for source dialogue.
4. Add captions only after the structural cut is stable. Keep captions on a
   dedicated visible track and review every generated caption for recognition
   mistakes, names, numbers, and timing.
5. Add B-roll, graphics, effects, and transitions only when they clarify a
   point, preserve attention, or bridge an actual change in idea. Do not use
   effects merely to make an edit look busy.
6. Mix last: dialogue is the priority; music and ambience support it on their
   own audio tracks, with ducking/fades where speech occurs.
7. Review the actual composited preview at the opening, each major text/graphic
   change, and the ending. Validate the project before rendering.

## Transcript-first speech editing

Talking heads, interviews, podcasts, and voice-led videos should start from
the word timeline, not broad video understanding. The transcript is shared
evidence for editing, captions, search, and emphasis.

1. Create/read the timestamped script. Each operation must retain both a
   stable source word reference and its specific timeline-item placement.
2. Separate facts from interpretation. Word timings, speaker text, and signal
   silence are evidence; a retake, tangent, weak section, or strongest hook is
   an editorial proposal that needs review.
3. Use fixed hesitation words (`um`, `uh`, `erm`, `ah`) as safe cleanup
   candidates. Treat contextual words such as “like”, “so”, “actually”, and
   “you know” as meaning-dependent; keep them unless their role is clearly
   padding and the user agrees.
4. Treat a transcript gap as a speech-gap candidate only. Run real silence
   analysis before saying it is dead air, then compress pauses to a natural
   amount rather than forcing every gap to zero.
5. Preview transcript edits before confirmation. The deterministic editor must
   translate selected source ranges into linked splits, removal, ripple, and
   undoable history; an LLM must never calculate those frame operations itself.
6. Once the story cut is accepted, create captions from the same word timeline
   so caption timings, search, and edit boundaries cannot drift apart.

## Track discipline

- Primary story footage: dedicated video track.
- B-roll: separate track above the primary footage; never cover a speaker or
  meaningful visual accidentally.
- Captions and graphics: separate overlay tracks; avoid competing lower-thirds
  and captions at the same time.
- Dialogue/voiceover, music, and sound effects: separate audio tracks.
- Name tracks by role. Avoid mixing unrelated roles on one track.

## Captions and text

- Generate a transcript from real media, then create editable caption items.
- Preserve the spoken meaning; correct names, product terms, and numbers.
- Keep caption timing aligned to speech. A caption should not linger after the
  spoken thought has ended.
- Keep text readable against its background; use contrast or a background/stroke
  when necessary. Do not place it over a face or important UI without review.
- Use captions as accessibility content first, visual decoration second.

## Audio

- Treat dialogue as the reference layer. Verify speech is understandable before
  adding music.
- Use fades at intentional entrances/exits. Duck music beneath dialogue instead
  of repeatedly cutting its volume by hand.
- Do not claim audio cleanup occurred unless the real audio tool completed and
  its result was verified.

## Motion and effects

- Prefer one readable movement per beat: position, scale, opacity, or a simple
  transition. Avoid stacking multiple effects without a reason.
- Keyframes must support the message (for example, a subtle emphasis zoom), not
  obscure footage or create motion sickness.
- Use a transition only at a change of scene, idea, or time; simple cuts are the
  normal default.

## Short-form first cut

- Put the strongest useful moment or promise early; do not manufacture claims.
- Remove approved pauses and repetitions, but preserve intentional comic beats,
  breaths, and emotional pacing.
- Use on-screen text or a voiceover when it supplies context the visual alone
  cannot convey.
- Review at normal playback speed before export. Do not label an edit "viral"
  or promise performance outcomes.

## Sources

These operational principles are adapted into SCLIP workflow rules from the
official documentation for transcript editing, captions, audio loudness/ducking,
and timeline review by Adobe Premiere, Blackmagic Design, and YouTube. They are
implemented as conservative editing defaults, not copied templates.
