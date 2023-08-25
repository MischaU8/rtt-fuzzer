"use strict"

const fs = require("fs")
const { FuzzedDataProvider } = require("@jazzer.js/core")

const RULES_JS_FILE = process.env.RTT_RULES || "rules.js"
const MAX_STEPS = parseInt(process.env.MAX_STEPS) || 2048

console.log(`Loading rtt-fuzzer RTT_RULES='${RULES_JS_FILE}' MAX_STEPS=${MAX_STEPS}`)
if (!fs.existsSync(RULES_JS_FILE)) {
    throw Error("rules.js not found, specify via RTT_RULES environment variable.")
}
const RULES = require(RULES_JS_FILE)

module.exports.fuzz = function(fuzzerInputData) {
    let data = new FuzzedDataProvider(fuzzerInputData)
    let seed = data.consumeIntegralInRange(1, 2**35-31)
    let scenario = data.pickValue(RULES.scenarios)

    // TODO randomize options
    const options = {}
    
    let game_setup = {
        "seed": seed,
        "scenario": scenario,
        "options": options
    }
    // console.log(game_setup)
    let state = RULES.setup(seed, scenario, options)

    let step = 0
    while (true) {
        let view = RULES.view(state, state.active)
        
        if (step > MAX_STEPS) {
            log_crash(game_setup, state, view, step)
            throw new MaxStepsExceededError(`Maximum step count (MAX_STEPS=${MAX_STEPS}) exceeded`)
        }
        
        if (state.state === 'game_over') {
            break
        }
        
        if (!view.actions) {
            log_crash(game_setup, state, view, step)
            throw new NoMoreActionsError("No actions defined")
        }
        
        let actions = view.actions
        if ('undo' in actions) {
            delete actions['undo']
        }
        
        if (actions.length === 0) {
            log_crash(game_setup, state, view, step)
            throw new NoMoreActionsError("No more actions to take (besides undo)")
        }
        let action = data.pickValue(Object.keys(actions))
        let args = actions[action]
        if (args !== undefined && args !== null && typeof args !== "number") {
            args = data.pickValue(args)
        }

        try {
            state = RULES.action(state, state.active, action, args)
        } catch (e) {
            log_crash(game_setup, state, view, step, action, args)
            throw new RulesCrashError(e, e.stack)
        }
        step += 1
    }
}


function log_crash(game_setup, state, view, step, action=undefined, args=undefined) {
    console.log()
    // console.log("STATE", state)
    console.log("GAME", game_setup)
    console.log("VIEW", view)
    if (action !== undefined) {
        console.log(`STEP=${step} ACTIVE=${state.active} ACTION: ${action} ` + JSON.stringify(args))
    } else {
        console.log(`STEP=${step} ACTIVE=${state.active}`)
    }
    console.log("STATE dumped to 'crash-state.json'\n")
    fs.writeFileSync("crash-state.json", JSON.stringify(state))
}

// Custom Error classes, allowing us to ignore expected errors with -x
class MaxStepsExceededError extends Error {
    constructor(message) {
      super(message)
      this.name = "MaxStepsExceededError"
    }
}

class NoMoreActionsError extends Error {
    constructor(message) {
      super(message)
      this.name = "NoMoreActionsError"
    }
}

class RulesCrashError extends Error {
    constructor(message, stack) {
      super(message)
      this.name = "RulesCrashError";
      this.stack = stack
    }
}
