#!/usr/bin/env python3
import csv
import hashlib
import shlex

fieldnames = ['ID', 'ERROR', 'MSG', 'STACK', 'STEP', 'ACTIVE', 'STATE', 'ACTION', 'ARGS', 'SETUP', 'DATA', 'DUMP']
key_fieldsnames = ['ERROR', 'STATE', 'MSG']

unique_errors = set()
with open('errors.txt', 'r') as f, open('errors.csv', 'w', newline='') as csvfile:
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()

    for line in f.readlines():
        line = line.strip()
        if line.startswith("Loading") or line.startswith("INFO:"):
            continue
        data = {}
        for keyval in shlex.split(line):
            try:
                key, val = keyval.split("=", 2)
                data[key] = val
            except ValueError:
                pass
        error_key = "_".join([data.get(key, '') for key in key_fieldsnames])
        if error_key not in unique_errors:
            unique_errors.add(error_key)
            data['ID'] = hashlib.sha256(error_key.encode()).hexdigest()[:8]
            writer.writerow(data)
