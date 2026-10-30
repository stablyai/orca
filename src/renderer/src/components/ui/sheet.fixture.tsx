import { defineFixture } from '../../component-fixtures/component-fixture'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './sheet'

export const modal = defineFixture({
  width: 1100,
  render: () => (
    <>
      <div className="app-layout bg-background p-6 text-foreground">
        <p>Workspace content stays live behind the sheet.</p>
      </div>
      <Sheet defaultOpen>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Sheet preview</SheetTitle>
            <SheetDescription>
              The sheet text stays sharp above the blurred workspace.
            </SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    </>
  )
})
