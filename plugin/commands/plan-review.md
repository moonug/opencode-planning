---
description: Open a markdown file in $EDITOR for interactive plan review. Pass the file path as $ARGUMENTS.
---

# /plan-review

The user invoked `/plan-review`. Open the markdown file for interactive
review via $EDITOR.

## Argument resolution

If `$ARGUMENTS` is a path, use it directly (relative paths resolved
against the working directory).

If `$ARGUMENTS` is empty, look for plan files in `docs/plans/` (the
convention from upstream cc-thingz planning plugin) — find the most
recent `.md` file in that directory, excluding `docs/plans/completed/`.
If `docs/plans/` does not exist, fall back to the current directory.

If multiple plans are found, list them and ask the user which one to
review.

## Workflow

Use the `plan_review` tool with the file contents to open the editor
and collect user annotations. Iterate on any diff returned by the tool
until the user closes the editor without changes (empty diff = approved).

If the diff is non-empty, the model should revise the plan based on the
feedback and call `plan_review` again. If the diff is empty (approved),
the session auto-switches to the build agent.
