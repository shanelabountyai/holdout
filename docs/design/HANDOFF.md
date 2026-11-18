# Design handoff

Source of truth for the UI built on branch `design/impl`. Exported 2026-11-18 from the Claude Design canvas so cloud runs don't depend on artifact access.

- Canvas: https://claude.ai/artifact/A4u3kaoQsiDYsvd81byE3Q
- Brief: https://claude.ai/artifact/AcQCd8KCm4PgWtA75jRfyX

## Artboards (`docs/design/*.dc.html`)

Each file is a self-contained Design Component: HTML with inline styles, `{{holes}}` filled by the `renderVals()` script at the bottom. Read the markup and the script together; the script holds the sample data.

| File | Screen | Frame |
| --- | --- | --- |
| `Main.dc.html` | Readout — Ship (with daily looks) | 1280×1500 |
| `States.dc.html` | Readout — all six decision states, in precedence order | 880×980 |
| `Srm.dc.html` | Readout — Stop: sample-ratio mismatch | 1280×860 |
| `New.dc.html` | New experiment — planned sample computed live | 1280×1000 |

## Owner calls (binding)

- SRM check kept at 80% power. (Shane, 2026-11-17)
- Sequential tests planned at 2× the fixed sample size. (Shane, 2026-11-14)
- The design plots the confidence sequence over daily looks and makes the planned-sample calculator live (brief recommendations). Record as DECISIONS rows.

## Gaps: screens the PRD needs that no artboard covers

- Experiment list (status, decision, days, progress to plan)
- Install snippet page / demo-site page

Design each gap as a new `docs/design/<Name>.dc.html` in the same look before building it.

## Placeholders

EXP-0042/0047 numbers are sample data; [n] and [p] are placeholders; decision-state order must follow D-32 exactly as coded (States artboard).
