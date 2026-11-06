#!/usr/bin/env python3
"""Read-only comparison of historical OptChat saved views. Prints metadata, never chat text.

Not a wire-payload capture. Reconstructs persisted parts plus trailing log entries,
using saved summary nodes. Does not replay scheduler/fit or prove a request used this view.
Usage: python3 tests/optchat-cache-snapshot.py [repo] [before-ref] [after-ref]
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

repo = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.home() / '.pi-opt-work/memory/profiles/main'
before, after = sys.argv[2:4] if len(sys.argv) > 3 else ('d346744^', 'd346744')

def git(*args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True)

def snapshot(ref):
    entries, nodes = [], {}
    for name in git('ls-tree', '-r', '--name-only', ref).splitlines():
        if not name.startswith(('main/', 'tree/')) or not name.endswith('.jsonl'):
            continue
        for line in git('show', ref + ':' + name).splitlines():
            item = json.loads(line)
            if name.startswith('main/'):
                entries.append(item)
            else:
                nodes[item['l'], item['i']] = item['text']
    entries.sort(key=lambda item: item['i'])
    saved = json.loads(git('show', ref + ':view.json'))
    parts = saved['parts'] if isinstance(saved, dict) else saved
    covered = sum(2 ** level for level, _ in parts)
    parts = parts + [[0, i] for i in range(covered, len(entries))]
    lines = [f'{index * 2**level}+{2**level}|' + re.sub(r'[\r\n]+', ' ', nodes.get((level, index), '(not summarized yet: zoom it)'))
             for level, index in parts]
    return lines, parts, len(entries), covered

left, lp, ln, lc = snapshot(before)
right, rp, rn, rc = snapshot(after)
shared = next((i for i, (a, b) in enumerate(zip(left, right)) if a != b), min(len(left), len(right)))
print(json.dumps({
    'before': git('show', '-s', '--format=%h %aI', before).strip(),
    'after': git('show', '-s', '--format=%h %aI', after).strip(),
    'entries': [ln, rn], 'saved_coverage': [lc, rc], 'rendered_lines': [len(left), len(right)],
    'unchanged_leading_lines': shared, 'first_part_before': lp[0], 'first_part_after': rp[0],
    'first_line_hash_before': hashlib.sha256(left[0].encode()).hexdigest(),
    'first_line_hash_after': hashlib.sha256(right[0].encode()).hexdigest(),
}, indent=2))
