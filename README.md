# claude-promptimize

`/promptimize` for Claude Code: a pane where you type a rough prompt, pick a size and get an optimized prompt back, after a short interview when the prompt leaves real gaps. The result lands in the prompt box, unsent, so you can edit it before you press Enter.

It is a Claude Code plugin with a hooks module (a "mod"). The mod API is early access and can change between releases.

## Install

### Requirements

- Claude Code 2.1.332 or newer. Check with `claude --version`; update with `claude update`.
- Git, which Claude Code uses to fetch the plugin from GitHub.

### Steps

1. Install the plugin. In a terminal session of Claude Code, type at the prompt:

   ```
   /plugin install promptimize --marketplace dimitritholen/claude-promptimize
   ```

   Or run this in a shell:

   ```bash
   claude plugin install promptimize --marketplace dimitritholen/claude-promptimize
   ```

2. Answer `y` when Claude Code asks to add the marketplace `dimitritholen/claude-promptimize`.
3. Choose a scope. `user` (the default) makes the plugin available in all your projects.
4. Set the options when asked, or press Enter to keep the defaults. They are described under [Settings](#settings).
5. Type `/promptimize`. A pane opens. If it does not, see [Troubleshooting](#troubleshooting).

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, then Add marketplace with `dimitritholen/claude-promptimize`, then Add plugin.

### Update and uninstall

```bash
claude plugin update promptimize      # then restart Claude Code
claude plugin uninstall promptimize
```

### Troubleshooting

- **`/promptimize` runs something else, or is not listed.** Another command or skill already has that name. The pane is then available as `/promptimize-pane`.
- **No pane opens.** The command prints why. A pane needs an interactive session: it does not open under `claude -p`.
- **The plugin does not load.** Run `claude plugin list` to see whether it is installed and enabled, and `claude --debug` to see why a hook was skipped.

### Run from a clone

To work on the plugin, clone the repository and load it from its folder for one session:

```bash
git clone https://github.com/dimitritholen/claude-promptimize
claude --plugin-dir claude-promptimize
```

## Use

Open the pane with `/promptimize [text]`. Typing `/promptimize` again closes it.

If another command or skill already holds the name `/promptimize`, the pane registers as `/promptimize-pane` instead.

1. **Compose.** Pick the model that writes the prompt and who the prompt is written for (this session, or a Claude, GPT, Gemini or image model used elsewhere), type the rough prompt, choose a size and, if the prompt refers to the conversation ("fix that", "the same for X"), tick *Include recent session context*. Enter in the prompt field or the Generate button starts.
   - **Small:** terse, 1 to 6 lines.
   - **Medium:** compact Markdown sections, about 100 to 250 words.
   - **Large:** a complete prompt of about 300 to 700 words with role, approach, constraints, a self-check and an output contract.

   The size sets how much is added. A rough prompt that is already long may grow beyond these ranges; a result over the limit is shortened once.
2. **Interview.** When the prompt leaves decisions open that only you can make and that change the result, the model asks questions first, each with a suggested default. A clear prompt gets none. Budget: small 2 questions in 1 round, medium 3 in up to 2 rounds, large 4 in up to 3 rounds. Enter answers; an empty Enter takes the default; `-` skips; *Use defaults and generate* takes the defaults for the rest.
3. **Review.** The pane shows the result, and above it what the model thinks you are after. If that reading is off, type what you are after in the field under it and press Enter: the prompt is written again from your words. *Use* puts it in the prompt box; `r` regenerates; `1`, `2`, `3` switch size (keeps your answers); `e` goes back to edit the rough prompt; `c` copies the result.

The model first works out the goal behind your words, then writes a new prompt from that goal instead of rearranging your text. Vague requirements ("polished", "complete") get a minimum bar the target can check; matters of taste ("original") get a working method. The prompt is written for the target you picked: by default a coding agent working in the current directory. What the agent can look up becomes an instruction to look it up; only what you alone know and the result cannot do without becomes an `[INSERT X]` placeholder.

Keys: Tab and the arrow keys move between the controls, Enter presses the focused one, Esc closes the pane and cancels a running request. While the model works, the Cancel button stops the request and keeps the pane open. The pane remembers your model, size, context choice and unfinished prompt for the session.

If the prompt box cannot take the text, the result goes to the clipboard and a toast says so.

### History

The pane keeps the last 50 prompts it wrote: the rough prompt, your choices and interview answers, the result, and whether you used or copied it. *History* in the compose step lists them, newest first. Enter on one opens it with its result, ready to use, copy or regenerate.

- *Export* writes the history to `promptimize-history.jsonl` in the working directory, one prompt per line, oldest first.
- *Clear* empties it.

The history stays on your machine, in the plugin's own store under your Claude Code configuration directory. The conversation is never kept, only whether you included it. Turn the history off with the `keepHistory` option.

### A shortcut

`/promptimize` is a toggle: on an open pane it closes the pane. Bind it to a key in `~/.claude/keybindings.json` and that key opens and closes the pane:

```json
{
  "bindings": [
    { "context": "Chat", "bindings": { "ctrl+x p": "command:promptimize" } }
  ]
}
```

If the pane registered as `/promptimize-pane`, bind `command:promptimize-pane`. `alt+p` is taken: it opens Claude Code's model picker.

## Settings

The plugin's options, in `/config` or under `pluginConfigs` in `~/.claude/settings.json`:

- `model`: the model the pane starts with, an alias (`opus`, `sonnet`, `haiku`) or a full model id. Default: the `model` in your settings, else `sonnet`. A model you pick in the pane wins for the rest of the session.
- `models`: extra model ids for the picker, separated by commas.
- `includeContext`: the default of the context box. Default `false`; it costs tokens.
- `keepHistory`: keep the history described above. Default `true`.

The interview call runs at low effort; the rewrite runs at the model's own effort. Model calls are billed to your session.

## Test

```bash
npm test             # claude plugin test: unit and pane tests, no model calls
npm run validate     # claude plugin validate
npm run eval         # real model: 10 rough prompts × 3 sizes, checked automatically
```

The eval answers interview questions with their defaults and checks per output: that it is a prompt and not the task's result (a judge call), language, length per size, number of placeholders, verbatim details, sentence length in the lists, and a number of interview questions within the range the case allows. Options: `--model id`, `--sizes small,medium`, `--cases id,id`, `--concurrency n`, `--runs n` (repeat each case and show how many runs passed), `--set dev|holdout|all` (the holdout cases are not used for tuning the prompts).

For cases marked `substance` a judge call counts how many of the rough prompt's vague requirements the output makes checkable. To check that judge against your own opinion: `node eval/run.ts --labels` writes `eval/labels.json`; set each `human` to `true` or `false`; `node eval/run.ts --check-judge` then reports how often the judge agrees. Full outputs go to `eval/out/` (git-ignored).

The eval calls the model through `claude -p`, so it uses your Claude Code sign-in and counts toward its usage. A full run makes about 90 model calls. It tests the prompts, not the pane: the pane calls the model through the mod API.

Type-check with the declarations Claude Code lays in `.claude-plugin/types/` once it has loaded the mod from this folder: `npx -p typescript tsc -p .`
