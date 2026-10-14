'use client';

// Adapted from shadcn/ui's base-nova sidebar. Keep the offcanvas composition used by this app.
import * as React from 'react';
import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { PanelLeft } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from './button.js';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './sheet.js';

interface SidebarContextProps {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  openMobile: boolean;
  setOpenMobile: React.Dispatch<React.SetStateAction<boolean>>;
  isMobile: boolean;
  toggleSidebar: () => void;
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null);
const mobileQuery = '(max-width: 1023px)';
function subscribeToViewport(callback: () => void) {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener('change', callback);
  return () => {
    query.removeEventListener('change', callback);
  };
}

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider.');
  return context;
}

function SidebarProvider({ className, children, ...props }: React.ComponentProps<'div'>) {
  const isMobile = React.useSyncExternalStore(
    subscribeToViewport,
    () => window.matchMedia(mobileQuery).matches,
    () => false,
  );
  const [open, setOpen] = React.useState(true);
  const [openMobile, setOpenMobile] = React.useState(false);
  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile((value) => !value);
    else setOpen((value) => !value);
  }, [isMobile]);
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'b' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [toggleSidebar]);
  React.useEffect(() => {
    if (!isMobile) setOpenMobile(false);
  }, [isMobile]);
  const value = React.useMemo(
    () => ({ open, setOpen, openMobile, setOpenMobile, isMobile, toggleSidebar }),
    [open, openMobile, isMobile, toggleSidebar],
  );
  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        className={cn(
          'group/sidebar-wrapper flex min-h-svh w-full [--sidebar-width:14rem]',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function Sidebar({ className, children, ...props }: React.ComponentProps<'div'>) {
  const { isMobile, open, openMobile, setOpenMobile } = useSidebar();
  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          id="dashboard-sidebar"
          side="left"
          data-slot="sidebar"
          data-mobile="true"
          closeLabel="Close navigation"
          className={cn(
            'h-svh max-w-[calc(100%-2rem)] gap-0 bg-card text-card-foreground outline-none data-[side=left]:w-72',
            className,
          )}
          {...props}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
            <SheetDescription>Projects and account</SheetDescription>
          </SheetHeader>
          {children}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <div
      data-slot="sidebar"
      data-state={open ? 'expanded' : 'collapsed'}
      data-collapsible={open ? '' : 'offcanvas'}
      className="group peer hidden text-card-foreground lg:block"
    >
      <div
        data-slot="sidebar-gap"
        className="relative w-(--sidebar-width) group-data-[collapsible=offcanvas]:w-0"
      />
      <div
        id="dashboard-sidebar"
        data-slot="sidebar-container"
        inert={!open}
        className={cn(
          'fixed inset-y-0 left-0 z-10 flex h-svh w-(--sidebar-width) border-r group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]',
          className,
        )}
        {...props}
      >
        <div data-slot="sidebar-inner" className="flex min-w-0 size-full flex-col bg-card">
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { isMobile, open, openMobile, toggleSidebar } = useSidebar();
  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className={className}
      aria-label="Toggle navigation"
      aria-expanded={isMobile ? openMobile : open}
      aria-controls="dashboard-sidebar"
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <PanelLeft />
    </Button>
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<'main'>) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn('relative flex min-w-0 flex-1 flex-col bg-background', className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn('flex min-w-0 shrink-0 flex-col gap-6 p-5 pt-7', className)}
      {...props}
    />
  );
}
function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn('flex min-w-0 shrink-0 flex-col gap-2 p-5', className)}
      {...props}
    />
  );
}
function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-5', className)}
      {...props}
    />
  );
}
function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn('relative flex w-full min-w-0 flex-col', className)}
      {...props}
    />
  );
}
function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn('flex w-full min-w-0 flex-col gap-1', className)}
      {...props}
    />
  );
}
function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn('group/menu-item relative min-w-0', className)}
      {...props}
    />
  );
}
function SidebarMenuButton({
  render,
  isActive = false,
  className,
  ...props
}: useRender.ComponentProps<'button'> & React.ComponentProps<'button'> & { isActive?: boolean }) {
  return useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(
      {
        type: 'button',
        className: cn(
          'peer/menu-button flex h-10 w-full min-w-0 items-center gap-3 overflow-hidden rounded-md p-2 text-left text-xs font-normal text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-active:bg-secondary/60 data-active:font-medium data-active:text-secondary-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&>span:last-child]:truncate',
          className,
        ),
      },
      props,
    ),
    render,
    state: { slot: 'sidebar-menu-button', sidebar: 'menu-button', active: isActive },
  });
}

export {
  Sidebar,
  SidebarProvider,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
};
