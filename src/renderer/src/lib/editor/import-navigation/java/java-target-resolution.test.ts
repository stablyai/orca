import { describe, expect, it } from 'vitest'
import type { ImportNavigationFileAccess } from '../import-navigation-file-access'
import { findJavaNavigationRequest } from './java-navigation-request'
import { outlineJavaSource } from './java-source-outline'
import { resolveJavaNavigationTarget } from './java-target-resolution'

const API = '/repo/api/src/main/java/com/acme/web'
const CORE = '/repo/core/src/main/java/com/acme/core'

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
  [`${CORE}/util/Helper.java`]: 'package com.acme.core.util;\n\npublic class Helper {}\n'
}

const access: ImportNavigationFileAccess = {
  pathsExist: async (paths) => paths.map((path) => path in FILES),
  readText: async (path) => FILES[path] ?? null,
  findFilesNamed: async (name) => Object.keys(FILES).filter((path) => path.endsWith(`/${name}`))
}

/** Resolves Go to Definition on the `nth` occurrence of `marker` in the controller. */
async function definitionAt(marker: string, nth = 0) {
  let offset = -1
  for (let index = 0; index <= nth; index += 1) {
    offset = CONTROLLER.indexOf(marker, offset + 1)
  }
  const outline = outlineJavaSource(CONTROLLER)
  const request = findJavaNavigationRequest(CONTROLLER, outline, offset)
  if (!request) {
    return null
  }
  const target = await resolveJavaNavigationTarget(
    access,
    { filePath: `${API}/AboutController.java`, rootPath: '/repo', content: CONTROLLER, outline },
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
})
