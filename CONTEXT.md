# Domain context

## Delegation

Delegation runs a focused task in an isolated `pi --mode json` subprocess. Scout, review, and commit are delegated tools with distinct model, prompt, timeout, tool, and output-limit policies but one shared execution lifecycle.

## Subagent preset

A subagent preset selects the model and thinking level used by each delegated tool for the current Pi session.
