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

        const state_freeze = JSON.stringify(ctx.state)

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

        if (state_freeze !== JSON.stringify(ctx.state)) {
            let stack
            try {
                RULES.view(deep_freeze(ctx.state), ctx.active)
            } catch (e) {
                stack = e.stack
            }
            let diff_keys = object_keypaths(deep_compare(JSON.parse(state_freeze), ctx.state))
            return log_crash(new ViewStateMutationError("View mutated state: " + diff_keys.join(", "), stack), ctx)
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

    const data_checksum = crypto.createHash('sha1')
    data_checksum.update(ctx.data)
    const data_hash = data_checksum.digest('hex')

    const game_checksum = crypto.createHash('sha1')
    game_checksum.update(JSON.stringify(game))
    const game_hash = game_checksum.digest('hex')

    const crash_file = `crash-${data_hash}`
    const out_file = `crash-${game_hash}.json`
    line += " SETUP=" + JSON.stringify(ctx.replay[0][2])
    line += ` DATA=${data_hash} DUMP=${out_file}`
    if (error.message)
        line += " MSG=" + JSON.stringify(error.message.replace(/^Error: /, ''))
    if (error.stack) {
        const regex = /\/Users\/\w+\/Projects\/rtt\//gi
        line += " STACK=" + JSON.stringify(error.stack.replace(regex, ''))
    }

    if (!fs.existsSync(out_file)) {
        console.log(line)
        fs.writeFileSync(out_file, JSON.stringify(game))
        if (NO_CRASH)
            fs.writeFileSync(crash_file, ctx.data)
    } else if (!NO_CRASH) {
        console.log(line)
    }
    if (!NO_CRASH) {
        throw error
    }
}

function deep_freeze(object) {
    // Retrieve the property names defined on object
    const propNames = Reflect.ownKeys(object);
    // Freeze properties before freezing self
    for (const name of propNames) {
      const value = object[name];
      if ((value && typeof value === "object") || typeof value === "function") {
        deep_freeze(value);
      }
    }
    return Object.freeze(object);
}

function deep_compare(obj1, obj2) {
    let diffObj = Array.isArray(obj2) ? [] : {}
    Object.getOwnPropertyNames(obj2).forEach(function(prop) {
        if (typeof obj2[prop] === 'object') {
            diffObj[prop] = deep_compare(obj1[prop], obj2[prop])
            // if it's an array with only length property => empty array => delete
            // or if it's an object with no own properties => delete
            if (Array.isArray(diffObj[prop]) && Object.getOwnPropertyNames(diffObj[prop]).length === 1 || Object.getOwnPropertyNames(diffObj[prop]).length === 0) {
                delete diffObj[prop]
            }
        } else if(obj1[prop] !== obj2[prop]) {
            diffObj[prop] = obj2[prop]
        }
    });
    return diffObj
}

function object_keypaths(obj, prefix='') {
    let keys = []
    for (const key in obj) {
        if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
            keys = keys.concat(object_keypaths(obj[key], `${prefix}${key}.`))
        } else {
            keys.push(`${prefix}${key}`)
        }
    }
    return keys
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

class ViewStateMutationError extends Error {
    constructor(message, stack) {
      super(message)
      this.name = "ViewStateMutationError";
      this.stack = stack
    }
}

class TimeoutError extends Error {
    constructor(message) {
      super(message)
      this.name = "TimeoutError"
    }
}
