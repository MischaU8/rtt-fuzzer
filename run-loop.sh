#!/bin/bash
set -e

MAX_TOTAL_TIME=1800

export TIMEOUT=1000
# export NO_ASSERT=true
export NO_CRASH=true
export NO_IMMUTABLE_VIEWSTATE=true
export NO_UNDO=true
export RTT_RULES=./rules.js

if [ -f "last_head" ]; then
    LAST_HEAD=`cat last_head`
else
    LAST_HEAD=""
fi

echo "LAST HEAD is $LAST_HEAD"

while true;
do
    echo "------------"
    echo "Updating GIT"
    echo "------------"
    cd paths-of-glory
    git pull --rebase

    # GIT_COMMIT=`git rev-parse --short HEAD`
    GIT_COMMIT=`git --no-pager log --format='%cs-%h' -n 1`

    # echo "--------------------"
    # echo "Compiling Typescript"
    # echo "--------------------"
    # tsc
    cd -

    if [[ "$GIT_COMMIT" != "$LAST_HEAD" ]]
    then
        echo "NEW HEAD is $GIT_COMMIT"
        LAST_HEAD=$GIT_COMMIT
        echo "$GIT_COMMIT" > last_head
        rm -f crash-* slow-unit-* timeout-* errors.txt
    fi

    echo "--------------"
    echo "Running Fuzzer"
    echo "--------------"
    npx jazzer rtt-module.js --sync corpus -- -max_total_time=$MAX_TOTAL_TIME | tee -a errors.txt

    echo "---------"
    echo "Reporting"
    echo "---------"
    ../errors2csv.py
    mv errors.csv errors-${GIT_COMMIT}.csv

    echo "--------------"
    echo "Merging Corpus"
    echo "--------------"
    mkdir -p corpus.new
    npx jazzer rtt-module.js --sync corpus.new corpus -- -merge=1

    echo "-------------"
    echo "Moving Corpus"
    echo "-------------"
    rm -rf corpus.old
    mv corpus corpus.old
    mv corpus.new corpus

    sleep 5
done
