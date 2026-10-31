import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AddRepoWslHostOffer } from './AddRepoWslHostOffer'

describe('AddRepoWslHostOffer', () => {
  it('names the distro from the path and offers both choices', () => {
    const html = renderToStaticMarkup(
      <AddRepoWslHostOffer
        offer={{
          path: '\\\\wsl$\\Ubuntu\\home\\me\\repo',
          distro: 'Ubuntu',
          source: 'local_folder_picker'
        }}
        onSettled={vi.fn()}
        addLocalPath={vi.fn()}
      />
    )
    expect(html).toContain('Run Ubuntu as a host (recommended)')
    expect(html).toContain('run natively in Linux')
    expect(html).toContain('Run as host')
    expect(html).toContain('Add on this computer')
  })
})
