import type { ReactElement } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslate } from "@/i18n/use-translate";
import { bundledSkillReplaceMovesCopyHint } from "./bundled-skill-setup-copy";

/** Says what Replace moves before the click; other actions render the button as is. */
export function BundledSkillReplaceHint({
  replacing,
  children,
}: {
  replacing: boolean;
  children: ReactElement;
}): ReactElement {
  const t = useTranslate();
  if (!replacing) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {bundledSkillReplaceMovesCopyHint(t)}
      </TooltipContent>
    </Tooltip>
  );
}
