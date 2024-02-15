"use strict"

const Ajv = require("ajv")
const ajv = new Ajv({allowUnionTypes: true})
const crypto = require('crypto')
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
            log_crash(ctx)
            throw new RulesCrashError(e, e.stack)
        }

        if (MAX_STEPS > 0 && ctx.step > MAX_STEPS) {
            log_crash(ctx)
            throw new MaxStepError("MAX_STEPS reached")
        }

        if (rules_view_schema && !rules_view_schema(ctx.view)) {
            log_crash(ctx)
            console.log(rules_view_schema.errors)
            throw new SchemaValidationError("View data fails schema validation")
        }

        if (ctx.state.state === 'game_over') {
            break
        }

        if (ctx.view.prompt && ctx.view.prompt.startsWith("Unknown state:")) {
            log_crash(ctx)
            throw new UnknownStateError(ctx.view.prompt)
        }

        if (!ctx.view.actions) {
            log_crash(ctx)
            throw new NoMoreActionsError("No actions defined")
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
            log_crash(ctx)
            throw new NoMoreActionsError("No more actions to take (besides undo)")
        }

        const action = data.pickValue(Object.keys(actions))
        let args = actions[action]
        const prev_seed = ctx.state.seed

        if (Array.isArray(args)) {
            // check for NaN as any suggested action argument and raise an error on those
            for (const arg of args) {
                if (isNaN(arg)) {
                    log_crash(ctx)
                    throw new InvalidActionArgument(`Action '${action}' argument has NaN value`)
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
            log_crash(ctx, action, args)
            throw new RulesCrashError(e, e.stack)
        }

        if (action === "undo") {
            if (ctx.state.active !== ctx.active && ctx.state.active !== "Both") {
                log_crash(ctx, action, args)
                throw new UndoActiveError(`undo caused active to switch from ${ctx.active} to ${ctx.state.active}`)
            }
            if (ctx.state.seed !== prev_seed) {
                log_crash(ctx, action, args)
                throw new UndoSeedError(`undo caused seed change from ${prev_seed} to ${ctx.state.seed}`)
            }
        }

        if (RULES.assert_state) {
            try {
                RULES.assert_state(ctx.state)
            } catch (e) {
                log_crash(ctx, action, args)
                throw new RulesCrashError(e, e.stack)
            }
        }

        ctx.step += 1
    }
}


function log_crash(ctx, action=undefined, args=undefined) {
    console.log()
    console.log("VIEW", ctx.view)
    console.log("SETUP", JSON.stringify(ctx.replay[0][2]))
    let line = `STEP=${ctx.step} ACTIVE=${ctx.active} STATE=${ctx.state?.state}`
    if (action !== undefined) {
        line += ` ACTION=${action}`
        if (args !== undefined)
            line += " " + JSON.stringify(args)
    }
    console.log(line)
    const game = {
        setup: {
            scenario: ctx.scenario,
            player_count: ctx.player_count,
            options: ctx.option,
        },
        players: ctx.players,
        state: ctx.state,
        replay: ctx.replay,
    }
    const shasum = crypto.createHash('sha1')
    shasum.update(ctx.data)
    const hash = shasum.digest('hex')
    const out_file = `crash-${hash}.json`
    fs.writeFileSync(out_file, JSON.stringify(game))
    console.log("DUMP", out_file)
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
