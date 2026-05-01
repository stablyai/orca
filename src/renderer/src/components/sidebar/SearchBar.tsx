import React, { useCallback } from 'react'
import { Search, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const SearchBar = React.memo(function SearchBar() {
  const searchQuery = useAppStore((s) => s.searchQuery)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)

  const handleClear = useCallback(() => setSearchQuery(''), [setSearchQuery])

  return (
    <div className="px-2 pb-1">
      <div className="relative flex items-center">
        <Search
          className="absolute left-2.5 size-3.5 text-muted-foreground pointer-events-none"
          strokeWidth={2.25}
        />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search..."
          className="h-7 pl-7 pr-8 text-[12px] border-none bg-muted/50 shadow-none focus-visible:ring-1 focus-visible:ring-ring/30 placeholder:text-muted-foreground/70"
        />
        {searchQuery && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleClear}
            className="absolute right-1 size-5"
          >
            <X className="size-3" />
          </Button>
        )}
      </div>
    </div>
  )
})

export default SearchBar
