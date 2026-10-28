---
name: sim-monitoring
description: Project-specific guidance for working in the Sim-monitoring repository, including safe changes, validation, and concise reporting.
---

# Sim-monitoring skill

Use this skill when making changes in the Sim-monitoring repository.

## Responsibilities
- Keep changes small, targeted, and easy to review.
- Prefer the smallest relevant file and test scope.
- Validate behavior with the most direct command available before reporting completion.
- Document assumptions, constraints, and verification evidence clearly.

## Working approach
1. Inspect the repository structure and identify the relevant code path before editing.
2. Confirm the root cause of the issue and avoid unrelated refactors.
3. Make the minimal fix that addresses the observed problem.
4. Run the narrowest relevant validation command and report the exact result.
5. Summarize what changed and how it was verified.

## Preferred validation patterns
- For Python code: run focused unit tests, or a direct Python check if no test suite exists.
- For syntax issues: use a Python compile check or the smallest available validation command.
- For repo changes: check git diff and ensure no unrelated files were modified.

## Guardrails
- Do not broaden scope without a clear reason.
- Do not claim success without fresh verification output.
- If a fix needs more context, ask for the missing fact instead of guessing.

## Example workflow
- Review the relevant files and identify the failing behavior.
- Add or update a focused test when the bug is reproducible.
- Implement one root-cause fix.
- Run the targeted validation command.
- Report the command used and its result.
