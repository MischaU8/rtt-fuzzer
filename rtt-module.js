"use strict"

const Ajv = require("ajv")
const ajv = new Ajv({allowUnionTypes: true})
const crypto = require('crypto')
const fs = require("fs")
const { FuzzedDataProvider } = require("@jazzer.js/core")

const RULES_JS_FILE = process.env.RTT_RULES || "rules.js"
const NO_ASSERT = process.env.NO_ASSERT === 'true'
const NO_CRASH = process.env.NO_CRASH === 'true'
const NO_SCHEMA = process.env.NO_SCHEMA === 'true'
const NO_UNDO = process.env.NO_UNDO === 'true'
const MAX_STEPS = parseInt(process.env.MAX_STEPS || 10000)
const TIMEOUT = parseInt(process.env.TIMEOUT || 250)

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
    const data = new FuzzedDataProvider(fuzzerInputData)
    if (data.remainingBytes < 16) {
        // insufficient bytes to start
        return
    }
    const seed = data.consumeIntegralInRange(1, 2**35-31)
    const scenarios = Array.isArray(RULES.scenarios) ? RULES.scenarios : Object.values(RULES.scenarios).flat()
    const scenario = data.pickValue(scenarios)
    // if (scenario.startsWith("Random"))
    //     return
    const timeout = TIMEOUT ? Date.now() + TIMEOUT : 0

    // TODO randomize options
    const options = {}

    const ctx = {
        data: fuzzerInputData,
        player_count: RULES.roles.length,
        players: RULES.roles.map(r => ({role: r, name: "rtt-fuzzer"})),
        scenario,
        options,
        replay: [],
        state: {},
        active: null,
        step: 0,
    }
    ctx.replay.push([null, ".setup", [seed, scenario, options]])
    ctx.state = RULES.setup(seed, scenario, options)

    while (true) {
        if (data.remainingBytes < 16) {
            // insufficient bytes to continue
            return
        }

        if (MAX_STEPS < 0 && ctx.step > -MAX_STEPS) {
            // Skip & ignore if we reach the limit
            return
        }

        ctx.active = ctx.state.active
        if (ctx.active === 'Both' || ctx.active === 'All') {
            // If multiple players can act, we'll pick a random player to go first.
            ctx.active = data.pickValue(RULES.roles)
        }

        ctx.view = {}
        try {
            ctx.view = RULES.view(ctx.state, ctx.active)
        } catch (e) {
            return log_crash(new RulesCrashError(e, e.stack), ctx)
        }

        if (MAX_STEPS > 0 && ctx.step > MAX_STEPS) {
            return log_crash(new MaxStepError(`MAX_STEPS ${MAX_STEPS} reached`), ctx)
        }

        if (TIMEOUT && (Date.now() > timeout)) {
            return log_crash(new TimeoutError(`TIMEOUT (${TIMEOUT}) reached`), ctx)
        }

        if (rules_view_schema && !rules_view_schema(ctx.view)) {
            return log_crash(new SchemaValidationError("View data fails schema validation: " + rules_view_schema.errors), ctx)
        }

        if (ctx.state.state === 'game_over') {
            break
        }

        if (ctx.view.prompt && ctx.view.prompt.startsWith("Unknown state:")) {
            return log_crash(new UnknownStateError(ctx.view.prompt), ctx)
        }

        if (!ctx.view.actions) {
            return log_crash(new NoMoreActionsError("No actions defined"), ctx)
        }

        const actions = ctx.view.actions
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
            return log_crash(new NoMoreActionsError(), ctx)
        }

        const action = data.pickValue(Object.keys(actions))
        let args = actions[action]
        const prev_seed = ctx.state.seed

        if (Array.isArray(args)) {
            // check for NaN as any suggested action argument and raise an error on those
            for (const arg of args) {
                if (isNaN(arg)) {
                    return log_crash(new InvalidActionArgument(`Action '${action}' argument has NaN value`), ctx)
                }
            }
            args = data.pickValue(args)
            ctx.replay.push([ctx.active, action, args])
        } else {
            args = undefined
            ctx.replay.push([ctx.active, action])
        }
        // console.log(active, action, args)
        try {
            ctx.state = RULES.action(ctx.state, ctx.active, action, args)
        } catch (e) {
            return log_crash(new RulesCrashError(e, e.stack), ctx, action, args)
        }

        if (action === "undo") {
            if (ctx.state.active !== ctx.active && ctx.state.active !== "Both") {
                return log_crash(new UndoActiveError(`undo caused active to switch from ${ctx.active} to ${ctx.state.active}`), ctx, action, args)
            }
            if (ctx.state.seed !== prev_seed) {
                return log_crash(new UndoSeedError(`undo caused seed change from ${prev_seed} to ${ctx.state.seed}`), ctx, action, args)
            }
        }

        if (!NO_ASSERT && RULES.assert_state) {
            try {
                RULES.assert_state(ctx.state)
            } catch (e) {
                return log_crash(new RulesAssertError(e, e.stack), ctx, action, args)
            }
        }

        ctx.step += 1
    }
}


function log_crash(error, ctx, action=undefined, args=undefined) {
    // console.log()
    // console.log("VIEW", ctx.view)
    let line = `ERROR=${error.name}`
    line += " SETUP=" + JSON.stringify(ctx.replay[0][2])
    line += ` STEP=${ctx.step} ACTIVE=${ctx.active} STATE=${ctx.state?.state}`
    if (action !== undefined) {
        line += ` ACTION=${action}`
        if (args !== undefined)
            line += " ARGS=" + JSON.stringify(args)
    }
    const game = {
        setup: {
            scenario: ctx.scenario,
            player_count: ctx.player_count,
            options: ctx.options,
        },
        players: ctx.players,
        state: ctx.state,
        replay: ctx.replay,
    }

    const shasum = crypto.createHash('sha1')
    shasum.update(ctx.data)
    const hash = shasum.digest('hex')

    const out_file = `crash-${hash}.json`
    line += ` DUMP=${out_file}`
    fs.writeFileSync(out_file, JSON.stringify(game))

    if (error.message)
        line += " MSG=" + JSON.stringify(error.message.replace(/^Error: /, ''))

    console.log(line)
    if (!NO_CRASH)
        throw error
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

class RulesAssertError extends Error {
    constructor(message, stack) {
      super(message)
      this.name = "RulesAssertError";
      this.stack = stack
    }
}

class SchemaValidationError extends Error {
    constructor(message) {
      super(message)
      this.name = "SchemaValidationError"
    }
}

class TimeoutError extends Error {
    constructor(message) {
      super(message)
      this.name = "TimeoutError"
    }
}
