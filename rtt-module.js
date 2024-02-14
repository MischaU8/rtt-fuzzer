"use strict"

const Ajv = require("ajv")
const ajv = new Ajv({allowUnionTypes: true})
const fs = require("fs")
const { FuzzedDataProvider } = require("@jazzer.js/core")

const RULES_JS_FILE = process.env.RTT_RULES || "rules.js"
const NO_UNDO = process.env.NO_UNDO === 'true'
const NO_SCHEMA = process.env.NO_SCHEMA === 'true'
const MAX_STEPS = parseInt(process.env.MAX_STEPS || 0)

console.log(`Loading rtt-fuzzer RTT_RULES='${RULES_JS_FILE}'`)
if (!fs.existsSync(RULES_JS_FILE)) {
    throw Error("rules.js not found, specify via RTT_RULES environment variable.")
}
const RULES = require(RULES_JS_FILE)

let rules_view_schema = null
if (!NO_SCHEMA && RULES.VIEW_SCHEMA) {
    console.log("View schema found; validating.")
    rules_view_schema = ajv.compile(RULES.VIEW_SCHEMA)
}

module.exports.fuzz = function(fuzzerInputData) {
    let data = new FuzzedDataProvider(fuzzerInputData)
    if (data.remainingBytes < 16) {
        // insufficient bytes to start
        return
    }
    let seed = data.consumeIntegralInRange(1, 2**35-31)
    let scenarios = Array.isArray(RULES.scenarios) ? RULES.scenarios : Object.values(RULES.scenarios).flat()
    let scenario = data.pickValue(scenarios)
    // if (scenario.startsWith("Random"))
    //     return

    // TODO randomize options
    const options = {}

    let replay = []
    let game_setup = [
        seed,
        scenario,
        options
    ]
    replay.push("\t.setup\t" + JSON.stringify(game_setup))
    let state = RULES.setup(seed, scenario, options)

    let step = 0
    while (true) {
        if (data.remainingBytes < 16) {
            // insufficient bytes to continue
            return
        }

        if (MAX_STEPS < 0 && step > -MAX_STEPS) {
            // Skip & ignore if we reach the limit
            return
        }

        let active = state.active
        if (active === 'Both' || active === 'All') {
            // If multiple players can act, we'll pick a random player to go first.
            active = data.pickValue(RULES.roles)
        }

        let view = {}
        try {
            view = RULES.view(state, active)
        } catch (e) {
            log_crash(replay, state, view, step, active)
            throw new RulesCrashError(e, e.stack)
        }

        if (MAX_STEPS > 0 && step > MAX_STEPS) {
            log_crash(replay, state, view, step, active)
            throw new MaxStepError("MAX_STEPS reached")
        }

        if (rules_view_schema && !rules_view_schema(view)) {
            log_crash(replay, state, view, step, active)
            console.log(rules_view_schema.errors)
            throw new SchemaValidationError("View data fails schema validation")
        }

        if (state.state === 'game_over') {
            break
        }

        if (view.prompt && view.prompt.startsWith("Unknown state:")) {
            log_crash(replay, state, view, step, active)
            throw new UnknownStateError(view.prompt)
        }

        if (!view.actions) {
            log_crash(replay, state, view, step, active)
            throw new NoMoreActionsError("No actions defined")
        }

        let actions = view.actions
        if (NO_UNDO && 'undo' in actions) {
            // remove `undo` from actions, useful to test for dead-ends
            delete actions['undo']
        }

        // Tor: view.actions["foo"] === 0 means the "foo" action is disabled (show the button in a disabled state)
        // Also ignoring the actions with `[]` as args, unsure about this but needed for Nevsky.
        for (const [key, value] of Object.entries(actions)) {
            if (value === false || value === 0 || value.length === 0) {
                delete actions[key]
            }
        }

        if (Object.keys(actions).length === 0) {
            log_crash(replay, state, view, step, active)
            throw new NoMoreActionsError("No more actions to take (besides undo)")
        }

        let action = data.pickValue(Object.keys(actions))
        let args = actions[action]
        let seed = state.seed

        if (args !== undefined && args !== null && typeof args !== "number" && typeof args !== "boolean") {
            // check for NaN as any suggested action argument and raise an error on those
            for (const arg in args) {
                if (isNaN(arg)) {
                    log_crash(replay, state, view, step, active)
                    throw new InvalidActionArgument(`Action '${action}' argument has NaN value`)
                }
            }
            args = data.pickValue(args)
        }
        // console.log(active, action, args)
        replay.push(active + "\t" + action + "\t" + JSON.stringify(args))
        try {
            state = RULES.action(state, active, action, args)
        } catch (e) {
            log_crash(replay, state, view, step, active, action, args)
            throw new RulesCrashError(e, e.stack)
        }

        if (action === "undo") {
            if (state.active !== active && state.active !== "Both") {
                log_crash(replay, state, view, step, active)
                throw new UndoActiveError(`undo caused active to switch from ${active} to ${state.active}`)
            }
            if (state.seed !== seed) {
                log_crash(replay, state, view, step, active)
                throw new UndoSeedError(`undo caused seed change from ${seed} to ${state.seed}`)
            }
        }

        if (RULES.assert_state) {
            try {
                RULES.assert_state(state)
            } catch (e) {
                log_crash(replay, state, view, step, active, action, args)
                throw new RulesCrashError(e, e.stack)
            }
        }

        step += 1
    }
}


function log_crash(replay, state, view, step, active, action=undefined, args=undefined) {
    console.log()
    // console.log("STATE", state)
    console.log("VIEW", view)
    console.log("SETUP", replay[0].split("\t")[2])
    if (action !== undefined) {
        console.log(`STEP=${step} ACTIVE=${active} STATE=${state?.state} ACTION: ${action} ` + JSON.stringify(args))
    } else {
        console.log(`STEP=${step} ACTIVE=${active} STATE=${state?.state}`)
    }
    // console.log("STATE & REPLAY dumped to 'crash-state.json' and 'crash-replay.txt'")
    fs.writeFileSync("crash-state.json", JSON.stringify(state))
    fs.writeFileSync("crash-replay.tsv", replay.join("\n") + "\n")
}

// Custom Error classes, allowing us to ignore expected errors with -x
class UnknownStateError extends Error {
    constructor(message) {
      super(message)
      this.name = "UnknownStateError"
    }
}

class MaxStepError extends Error {
    constructor(message) {
      super(message)
      this.name = "MaxStepError"
    }
}

class NoMoreActionsError extends Error {
    constructor(message) {
      super(message)
      this.name = "NoMoreActionsError"
    }
}

class InvalidActionArgument extends Error {
    constructor(message) {
      super(message)
      this.name = "InvalidActionArgument"
    }
}

class UndoActiveError extends Error {
    constructor(message) {
      super(message)
      this.name = "UndoActiveError"
    }
}

class UndoSeedError extends Error {
    constructor(message) {
      super(message)
      this.name = "UndoSeedError"
    }
}

class RulesCrashError extends Error {
    constructor(message, stack) {
      super(message)
      this.name = "RulesCrashError";
      this.stack = stack
    }
}

class SchemaValidationError extends Error {
    constructor(message) {
      super(message)
      this.name = "SchemaValidationError"
    }
}
