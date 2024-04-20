#!/usr/bin/env python3
import csv
import shlex

unique_errors = set()

with open('errors.txt', 'r') as f, open('errors.csv', 'w', newline='') as csvfile:
    fieldnames = ['ERROR', 'MSG', 'STACK', 'STEP', 'ACTIVE', 'STATE', 'ACTION', 'ARGS', 'SETUP', 'DATA', 'DUMP']
    key_fieldsnames = ['ERROR', 'STATE', 'MSG']
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    writer.writeheader()

    for line in f.readlines():
        line = line.strip()
        if line.startswith("Loading") or line.startswith("INFO:"):
            continue
        # print(line)
        data = {}
        for keyval in shlex.split(line):
            # print(keyval)
            key, val = keyval.split("=", 2)
            # print("key", key)
            # print("val", val)
            data[key] = val
        error_key = "_".join([data.get(key, '') for key in key_fieldsnames])
        if error_key not in unique_errors:
            unique_errors.add(error_key)
            writer.writerow(data)
