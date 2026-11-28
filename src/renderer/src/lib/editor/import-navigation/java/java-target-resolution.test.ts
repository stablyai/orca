import { describe, expect, it } from 'vitest'
import type { ImportNavigationFileAccess } from '../import-navigation-file-access'
import { findJavaNavigationRequest } from './java-navigation-request'
import { outlineJavaSource } from './java-source-outline'
import { resolveJavaNavigationTarget } from './java-target-resolution'

const API = '/repo/api/src/main/java/com/acme/web'
const CORE = '/repo/core/src/main/java/com/acme/core'
const SHOP = '/repo/shop/src/main/java/com/acme/shop'

const CONTROLLER = `package com.acme.web;

import com.acme.core.LocalizedController;
import com.acme.core.util.*;
import static com.acme.core.Strings.trim;

// Helper and Model are resolved without explicit imports.
public class AboutController extends LocalizedController {
    private final Helper helper = new Helper();

    public String index(Model model) {
        String title = format(trim(" about "));
        String page = render(model.toString());
        return localizedView(model, page, title);
    }

    private String format(String value) {
        return value;
    }
}
`

const CHILD = `package com.acme.shop;

import static com.acme.core.Strings.trim;
import static com.acme.shop.Flags.*;

class Helper {
    void unrelated() {}
}

public class Child extends Base {
    private static final String TAG = """
        /* not a comment
        """;

    void reset() {
        int count = 0;
    }

    void run() {
        this.count++;
        trim(TAG);
        boolean ready = READY;
        Options options = null;
        Outer.Inner.run();
        inherited();
    }

    String trim(String value) {
        return value;
    }

    static class Nested extends Base {
        void check() {
            reset();
        }
    }
}
`

const FILES: Record<string, string> = {
  [`${API}/AboutController.java`]: CONTROLLER,
  [`${API}/Model.java`]: 'package com.acme.web;\n\npublic class Model {}\n',
  [`${CORE}/LocalizedController.java`]: `package com.acme.core;

public abstract class LocalizedController extends BaseController {
    protected String localizedView(Model model, String view, String title) {
        String localizedView = view;
        return localizedView;
    }
}
`,
  [`${CORE}/BaseController.java`]:
    'package com.acme.core;\n\npublic class BaseController {\n    protected String render(String view) {\n        return view;\n    }\n}\n',
  [`${CORE}/Strings.java`]:
    'package com.acme.core;\n\npublic final class Strings {\n    public static String trim(String value) {\n        return value.trim();\n    }\n}\n',
  [`${CORE}/util/Helper.java`]: 'package com.acme.core.util;\n\npublic class Helper {}\n',
  [`${SHOP}/Child.java`]: CHILD,
  [`${SHOP}/Base.java`]: `package com.acme.shop;

public class Base {
    protected int count;

    public static class Options {}

    protected void inherited() {}

    protected void reset() {}
}
`,
  [`${SHOP}/Flags.java`]:
    'package com.acme.shop;\n\npublic final class Flags {\n    public static final boolean READY = true;\n}\n',
  [`${SHOP}/Outer.java`]: `package com.acme.shop;

public class Outer {
    public static void run() {}

    public static class Inner { public static void run() {} }
}
`
}

const access: ImportNavigationFileAccess = {
  pathsExist: async (paths) => paths.map((path) => path in FILES),
  readText: async (path) => FILES[path] ?? null,
  findFilesNamed: async (name) => Object.keys(FILES).filter((path) => path.endsWith(`/${name}`))
}

/** Resolves Go to Definition on the `nth` occurrence of a marker in the file at `filePath`. */
function definitionsIn(filePath: string) {
  const content = FILES[filePath]
  return async (marker: string, nth = 0) => {
    let offset = -1
    for (let index = 0; index <= nth; index += 1) {
      offset = content.indexOf(marker, offset + 1)
    }
    const outline = outlineJavaSource(content)
    const request = findJavaNavigationRequest(outline, offset)
    if (!request) {
      return null
    }
    const target = await resolveJavaNavigationTarget(
      access,
      { filePath, rootPath: '/repo', content, outline },
      request
    )
    return (
      target && {
        filePath: target.filePath,
        line: target.content.slice(0, target.offset).split('\n').length,
        word: target.content.slice(target.offset, target.offset + marker.length)
      }
    )
  }
}

const definitionAt = definitionsIn(`${API}/AboutController.java`)
const childDefinitionAt = definitionsIn(`${SHOP}/Child.java`)

describe('Java Go to Definition', () => {
  it('opens types from another module, the same package, wildcard imports and import lines', async () => {
    expect(await definitionAt('LocalizedController', 1)).toEqual({
      filePath: `${CORE}/LocalizedController.java`,
      line: 3,
      word: 'LocalizedController'
    })
    expect(await definitionAt('LocalizedController', 0)).toEqual({
      filePath: `${CORE}/LocalizedController.java`,
      line: 3,
      word: 'LocalizedController'
    })
    expect(await definitionAt('Helper', 1)).toEqual({
      filePath: `${CORE}/util/Helper.java`,
      line: 3,
      word: 'Helper'
    })
    expect(await definitionAt('Model', 1)).toEqual({
      filePath: `${API}/Model.java`,
      line: 3,
      word: 'Model'
    })
  })

  it('finds members in the file, up the extends chain and through import static', async () => {
    expect(await definitionAt('localizedView')).toEqual({
      filePath: `${CORE}/LocalizedController.java`,
      line: 4,
      word: 'localizedView'
    })
    expect(await definitionAt('render')).toEqual({
      filePath: `${CORE}/BaseController.java`,
      line: 4,
      word: 'render'
    })
    expect(await definitionAt('trim', 1)).toEqual({
      filePath: `${CORE}/Strings.java`,
      line: 4,
      word: 'trim'
    })
    expect(await definitionAt('format')).toEqual({
      filePath: `${API}/AboutController.java`,
      line: 17,
      word: 'format'
    })
  })

  it('leaves members of variables, keywords and comments alone', async () => {
    expect(await definitionAt('toString')).toBeNull()
    expect(await definitionAt('return')).toBeNull()
    expect(await definitionAt('resolved without')).toBeNull()
  })

  it('looks names up from the type around the cursor, as Java scopes them', async () => {
    // Another method's local does not hide the inherited field.
    expect(await childDefinitionAt('count', 1)).toEqual({
      filePath: `${SHOP}/Base.java`,
      line: 4,
      word: 'count'
    })
    // The class's own method shadows the statically imported one.
    expect(await childDefinitionAt('trim', 1)).toEqual({
      filePath: `${SHOP}/Child.java`,
      line: 28,
      word: 'trim'
    })
    expect(await childDefinitionAt('TAG', 1)).toEqual({
      filePath: `${SHOP}/Child.java`,
      line: 11,
      word: 'TAG'
    })
    expect(await childDefinitionAt('READY')).toEqual({
      filePath: `${SHOP}/Flags.java`,
      line: 4,
      word: 'READY'
    })
    expect(await childDefinitionAt('Options')).toEqual({
      filePath: `${SHOP}/Base.java`,
      line: 6,
      word: 'Options'
    })
    // Inner's own `run`, though it shares a line with Inner's opening brace.
    expect(await childDefinitionAt('run', 1)).toEqual({
      filePath: `${SHOP}/Outer.java`,
      line: 6,
      word: 'run'
    })
    // Child's supertypes apply, not those of Helper before it.
    expect(await childDefinitionAt('inherited')).toEqual({
      filePath: `${SHOP}/Base.java`,
      line: 8,
      word: 'inherited'
    })
    // A nested type's inherited method shadows the outer type's own.
    expect(await childDefinitionAt('reset', 1)).toEqual({
      filePath: `${SHOP}/Base.java`,
      line: 10,
      word: 'reset'
    })
  })
})
