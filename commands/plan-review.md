---
description: Open a markdown file in $EDITOR for interactive plan review. Pass the file path as $ARGUMENTS.
---

The user invoked `/plan-review`. Open the markdown file at `$ARGUMENTS`
(or the most recent plan file in the session if no argument given) for
interactive review via $EDITOR.

Use the plan_review tool with the file contents to open the editor and
collect user annotations. Iterate on any diff returned by the tool until
the user closes the editor without changes (empty diff = approved).

If `$ARGUMENTS` is empty, look for the most recent `.md` file in
`docs/plans/` or current directory and pass its contents to plan_review.
Ask the user if ambiguous.