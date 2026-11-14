import { PLUGIN_EVENT_NAMES } from '../contributions/plugin-event-contribution'
import { PLUGIN_PANEL_REQUEST_MAX_TIMEOUT_MS } from '../workers/plugin-panel-bridge-protocol'

/**
 * Part of the frame shell's IIFE (plugin-panel-shell.ts), after `orca` exists: `orca.plugin`
 * (requests to and posts from the plugin's worker), `orca.storage`, `orca.settings`,
 * `orca.secrets`, and `orca.on` for workspace and agent events. Uses the shell's `call`, `on`,
 * `emit` and `failure`; `receivePush` handles the host's `plugin.push` event.
 */
export const PLUGIN_FRAME_FACADES_SCRIPT = `
  var domainEvents = ${JSON.stringify(PLUGIN_EVENT_NAMES)}
  var subscribed = new Set()
  var pluginListeners = new Map()
  var dataListeners = new Map()
  function listen(map, name, fn) {
    if (typeof fn !== 'function') throw new TypeError('a listener must be a function')
    var set = map.get(name) || new Set()
    map.set(name, set)
    var entry = function (payload) { return fn(payload) }
    set.add(entry)
    return Object.freeze({ dispose: function () { set.delete(entry) } })
  }
  function fire(map, name, payload) {
    var set = map.get(name)
    if (set) Array.from(set).forEach(function (fn) {
      try { Promise.resolve(fn(payload)).catch(function (e) { console.error(e) }) } catch (e) { console.error(e) }
    })
  }
  function onEvent(name, fn) {
    var subscription = on(name, fn)
    if (domainEvents.indexOf(name) >= 0 && !subscribed.has(name)) {
      subscribed.add(name)
      call('events.subscribe', { event: name }).catch(function (e) {
        subscribed.delete(name)
        console.warn('[orca] cannot receive ' + name + ': ' + (e && e.message))
      })
    }
    return subscription
  }
  function receivePush(p) {
    if (!p) return
    if (p.kind === 'message') fire(pluginListeners, String(p.event), p.payload)
    else if (p.kind === 'event') emit(String(p.event), p.payload)
    else if (p.kind === 'changed') fire(dataListeners, String(p.area), Object.freeze({ key: String(p.key) }))
  }
  function pick(name) { return function (result) { return result ? result[name] : undefined } }
  function done() { return undefined }
  orca.on = onEvent
  orca.plugin = Object.freeze({
    request: function (name, input, options) {
      var o = options || {}
      var params = { name: String(name) }
      if (input !== undefined) params.input = input
      if (typeof o.timeoutMs === 'number' && o.timeoutMs > 0) {
        params.timeoutMs = Math.min(Math.ceil(o.timeoutMs), ${PLUGIN_PANEL_REQUEST_MAX_TIMEOUT_MS})
      }
      return call('plugin.request', params, { signal: o.signal }).then(pick('output'))
    },
    on: function (event, fn) { return listen(pluginListeners, String(event), fn) }
  })
  orca.storage = Object.freeze({
    get: function (key) {
      return call('storage.get', { key: String(key) }).then(pick('value')).then(function (v) { return v === undefined ? null : v })
    },
    set: function (key, value) { return call('storage.set', { key: String(key), value: value }).then(done) },
    delete: function (key) { return call('storage.delete', { key: String(key) }).then(done) },
    keys: function () { return call('storage.keys').then(pick('keys')) },
    onDidChange: function (fn) { return listen(dataListeners, 'storage', fn) }
  })
  orca.settings = Object.freeze({
    get: function (key) {
      return call('settings.get').then(function (result) {
        var all = (result && result.settings) || {}
        return key === undefined ? all : (Object.prototype.hasOwnProperty.call(all, key) ? all[key] : undefined)
      })
    },
    set: function (key, value) { return call('settings.set', { key: String(key), value: value }).then(done) },
    onDidChange: function (fn) { return listen(dataListeners, 'settings', fn) }
  })
  orca.secrets = Object.freeze({
    get: function (key) { return call('secrets.get', { key: String(key) }).then(pick('value')) },
    set: function (key, value) { return call('secrets.set', { key: String(key), value: String(value) }).then(done) },
    delete: function (key) { return call('secrets.delete', { key: String(key) }).then(done) }
  })
`
