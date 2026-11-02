/**
 * Part of the frame shell's IIFE (plugin-panel-shell.ts): an editor's `orca.document`, including
 * `session()`, the document sync every editor otherwise rebuilds. Uses the shell's `call`, `on`,
 * `latest`, `waiting`, `starting` and `helloSeen`.
 *
 * The baseline (`base`, `baseVersion`, `baseContent`) moves only when Orca accepts an edit or sends
 * a document while nothing is unaccepted, so a refused edit leaves a draft that is still dirty.
 */
export const PLUGIN_FRAME_DOCUMENT_SCRIPT = `
  function start() {
    if (helloSeen && latest) starting.splice(0).forEach(function (resolve) { resolve(latest) })
  }
  // Resolves with the latest document once hello brought theme and locale.
  function whenStarted() {
    return helloSeen && latest ? Promise.resolve(latest) : new Promise(function (resolve) { starting.push(resolve) })
  }
  function applyEdit(edit) {
    var base = edit && edit.baseVersion
    var content = edit && edit.content ? Object.assign({}, edit.content) : null
    // Copied: the caller may reuse its buffer, and get() must keep what Orca accepted.
    if (content && content.bytes instanceof ArrayBuffer) content.bytes = content.bytes.slice(0)
    return call(C.editor.applyEdit, edit).then(function (result) {
      // Accepted edits keep their version, so get() takes the content without a new version.
      if (latest && content && latest.version === base) {
        latest = Object.freeze(Object.assign({}, latest, { content: Object.freeze(content) }))
      }
      return result
    })
  }
  if (C.surface === 'editor') {
    orca.document = Object.freeze({
      get: function () {
        return latest ? Promise.resolve(latest) : new Promise(function (resolve) { waiting.push(resolve) })
      },
      // Why replay: editors often subscribe after their bundle loads, when the first document is in.
      onDidChange: function (fn) {
        var subscription = on(E.editorDocument, fn)
        var current = latest
        var live = true
        if (current) Promise.resolve().then(function () { if (live && latest === current) fn(current) })
        return Object.freeze({ dispose: function () { live = false; subscription.dispose() } })
      },
      applyEdit: applyEdit,
      session: documentSession
    })
  }
  function sameContent(a, b) {
    if (!a || !b || a.kind !== b.kind) return false
    if (a.kind === 'text') return a.text === b.text
    if (!(a.bytes instanceof ArrayBuffer) || !(b.bytes instanceof ArrayBuffer)) return false
    if (a.bytes.byteLength !== b.bytes.byteLength) return false
    var x = new Uint8Array(a.bytes), y = new Uint8Array(b.bytes)
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
    return true
  }
  function decodeText(content) {
    if (content.kind !== 'text') throw new TypeError('a bytes document needs session decode and encode')
    return content.text
  }
  function encodeText(value) { return { kind: 'text', text: String(value) } }
  function documentSession(options) {
    var o = options || {}
    var decode = typeof o.decode === 'function' ? o.decode : decodeText
    var encode = typeof o.encode === 'function' ? o.encode : encodeText
    var merge = typeof o.merge === 'function' ? o.merge : null
    // Why 250: the host takes 60 edits per 10 s, and typing must stay under that.
    var debounceMs = typeof o.debounceMs === 'number' && o.debounceMs >= 0 ? o.debounceMs : 250
    return whenStarted().then(function (first) {
      var doc = first
      var base = decode(first.content)
      var baseContent = first.content
      var baseVersion = first.version
      var value = base
      var dirty = false
      var posted = undefined
      var inFlight = null
      var timer = null
      var disposed = false
      var replaced = new Set()
      function emitReplace(next) {
        Array.from(replaced).forEach(function (fn) {
          try { fn(next) } catch (e) { console.error(e) }
        })
      }
      function clearTimer() { if (timer !== null) { clearTimeout(timer); timer = null } }
      function rebase(next) {
        doc = next
        base = decode(next.content)
        baseContent = next.content
        baseVersion = next.version
        return base
      }
      function refused(error) {
        if (!error || error.code !== 'conflict' || doc.version === baseVersion) throw error
        var previous = base
        var mine = value
        var outside = rebase(doc)
        // Without merge the draft stays; the next change or flush sends it over the newer document.
        if (!merge) throw error
        value = merge(previous, outside, mine)
        emitReplace(value)
        return send()
      }
      function send() {
        clearTimer()
        var sent = value
        var content
        try { content = encode(sent) } catch (e) { return Promise.reject(e) }
        posted = sent
        var attempt = applyEdit({ baseVersion: baseVersion, content: content }).then(function () {
          base = sent
          baseContent = content
          if (value === sent) dirty = false
        }, refused)
        inFlight = attempt
        attempt.then(settled, settled)
        function settled() {
          if (inFlight === attempt) inFlight = null
          if (!disposed && dirty && value !== posted && timer === null && inFlight === null) {
            send().catch(function () {})
          }
        }
        return attempt
      }
      function flush() {
        clearTimer()
        if (disposed) return Promise.resolve()
        var current = inFlight
        if (!current) return dirty && !doc.readOnly ? send() : Promise.resolve()
        var sentValue = posted
        return current.then(function () {
          return value !== sentValue ? flush() : undefined
        }, function (error) {
          if (value !== sentValue) return flush()
          throw error
        })
      }
      var documents = on(E.editorDocument, function (next) {
        if (disposed || next.version === doc.version) return
        doc = next
        // Unaccepted work waits for its edit's conflict, where merge runs.
        if (dirty || inFlight) return
        if (sameContent(next.content, baseContent)) { baseVersion = next.version; return }
        value = rebase(next)
        emitReplace(value)
      })
      var flushes = on(C.editor.flush, function () {
        clearTimer()
        // Posted is enough: Orca reads it before this answer, and waiting could outlast its deadline.
        if (disposed || !dirty || doc.readOnly || (inFlight && value === posted)) return
        send().catch(function () {})
      })
      return Object.freeze({
        get value() { return value },
        get readOnly() { return doc.readOnly },
        change: function (next) {
          if (disposed || doc.readOnly) return
          value = next
          dirty = true
          clearTimer()
          timer = setTimeout(function () {
            timer = null
            if (!inFlight) send().catch(function () {})
          }, debounceMs)
        },
        flush: function () { return flush().then(function () {}) },
        onReplace: function (fn) {
          if (typeof fn !== 'function') throw new TypeError('onReplace needs a handler')
          var entry = function (next) { fn(next) }
          replaced.add(entry)
          return Object.freeze({ dispose: function () { replaced.delete(entry) } })
        },
        dispose: function () {
          disposed = true
          clearTimer()
          documents.dispose()
          flushes.dispose()
          replaced.clear()
        }
      })
    })
  }
`
