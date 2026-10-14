import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeedback } from '../feedback-queries.js';
import {
  ArrowUpRight,
  ChevronsUpDown,
  Bot,
  Code2,
  LogOut,
  MessageCircle,
  Palette,
  Plus,
  Users,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { z } from 'zod';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { messageOf, request } from '../ui.js';
import { Button } from '../components/ui/button.js';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../components/ui/breadcrumb.js';
import {
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
} from '../components/ui/sidebar.js';
import { Badge } from '../components/ui/badge.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../components/ui/dropdown-menu.js';
import { Brand, Choice, Empty, Person } from '../components/common.js';

import { createContext, useContext } from 'react';
import { projectListSchema } from './models.js';
import type { Account, ProjectWithRole } from './models.js';
import { useSession } from './session.js';
import { NewProject } from './new-project.js';

type View = 'feedback' | 'install' | 'appearance' | 'people' | 'agents' | 'account';
const navigation: { id: View; label: string; icon: LucideIcon }[] = [
  { id: 'feedback', label: 'Feedback', icon: MessageCircle },
  { id: 'install', label: 'Installation', icon: Code2 },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'people', label: 'People', icon: Users },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'account', label: 'Account security', icon: ShieldCheck },
];
interface DashboardState {
  project: ProjectWithRole | undefined;
  user: Account;
  saveProject: (input: unknown) => Promise<void>;
  tryDemo: () => void;
  refresh: () => Promise<void>;
  openNewProject: () => void;
  feedbackFilter: string;
  setFeedbackFilter: (filter: string) => void;
  feedbackSearch: string;
  setFeedbackSearch: (search: string) => void;
}
const DashboardContext = createContext<DashboardState | null>(null);
export function useDashboard() {
  const dashboard = useContext(DashboardContext);
  if (!dashboard) throw new Error('A dashboard route must use the dashboard layout.');
  return dashboard;
}
export default function DashboardLayout() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5000, retry: 1 } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <DashboardContent />
      </SidebarProvider>
    </QueryClientProvider>
  );
}
function DashboardContent() {
  const { user, onLogout, demoUrl } = useSession();
  const { isMobile, setOpenMobile } = useSidebar();
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const view = navigation.find((item) => location.pathname === `/${item.id}`)?.id ?? 'feedback';
  const [selected, setSelected] = useState(() => localStorage.getItem('feedback-project-v1') ?? '');
  const [newOpen, setNewOpen] = useState(false);
  const [feedbackFilter, setFeedbackFilter] = useState('all');
  const [feedbackSearch, setFeedbackSearch] = useState('');
  const projectQuery = useQuery({
    queryKey: ['projects'],
    queryFn: async ({ signal }) =>
      z.object({ projects: projectListSchema }).parse(await request('/api/projects', { signal }))
        .projects,
    refetchInterval: 10_000,
  });
  const projects = projectQuery.data ?? [];
  const p = projects.find((item) => item.id === selected) ?? projects[0];
  const projectId = p?.id ?? '';
  const { threads } = useFeedback(projectId, '', 'all', null);
  const ready = !projectQuery.isPending;
  const failure = projectQuery.error;
  useEffect(() => {
    if (failure) toast.error(messageOf(failure));
  }, [failure]);
  useEffect(() => {
    if (projectId) localStorage.setItem('feedback-project-v1', projectId);
  }, [projectId]);
  const refresh = async () => {
    await client.invalidateQueries();
  };
  const saveProject = async (input: unknown) => {
    if (!p) return;
    await request(`/api/projects/${p.id}`, { method: 'PATCH', body: input });
    await refresh();
  };
  const tryDemo = () => {
    if (!p) return;
    const destination = new URL(demoUrl);
    if (!p.origins.includes(destination.origin)) {
      toast.error('Add the example website origin in Installation first.');
      return;
    }
    destination.searchParams.set('project', p.id);
    destination.hash = 'feedback-connect';
    window.open(destination.href, '_blank', 'noopener');
  };
  const changeView = (next: View) => {
    void navigate(`/${next}`);
    setOpenMobile(false);
  };
  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <Brand small />
          <div className="min-w-0 rounded-lg border bg-muted/30 p-3">
            <Choice
              label="Project"
              value={p?.id ?? ''}
              options={projects.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(value) => {
                setSelected(value);
              }}
            />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <nav aria-label="Project navigation">
              <SidebarMenu>
                {navigation.map(({ id, label, icon: Icon }) => (
                  <SidebarMenuItem key={id}>
                    <SidebarMenuButton
                      render={<Link to={`/${id}`} />}
                      isActive={view === id}
                      aria-label={label}
                      aria-current={view === id ? 'page' : undefined}
                      onClick={() => {
                        setOpenMobile(false);
                      }}
                    >
                      <Icon />
                      <span>{label}</span>
                      {id === 'feedback' &&
                      threads.filter((thread) => thread.status === 'open').length ? (
                        <Badge variant="secondary" className="ml-auto text-[9px]">
                          {threads.filter((thread) => thread.status === 'open').length}
                        </Badge>
                      ) : null}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroup>
          <Button
            variant="ghost"
            size="sm"
            className="justify-start text-muted-foreground"
            onClick={() => {
              setOpenMobile(false);
              setNewOpen(true);
            }}
          >
            <Plus className="size-3.5" /> New project
          </Button>
        </SidebarContent>
        <SidebarFooter>
          <div className="border-t pt-4">
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<SidebarMenuButton className="h-14 gap-2" aria-label="Account menu" />}
                  >
                    <Person name={user.name} />
                    <span className="min-w-0 flex-1 text-left text-xs normal-case">
                      <span data-feedback-content className="block truncate" title={user.name}>
                        {user.name}
                      </span>
                      <span className="mt-1 block text-[10px] capitalize text-muted-foreground">
                        {p?.role ?? 'Account'}
                      </span>
                    </span>
                    <ChevronsUpDown className="ml-auto" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side={isMobile ? 'top' : 'right'}
                    align="end"
                    sideOffset={isMobile ? 8 : 28}
                    className="w-56 max-w-[calc(100vw-1rem)]"
                  >
                    <DropdownMenuItem onClick={onLogout}>
                      <LogOut /> Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex min-h-[74px] flex-wrap items-center justify-between gap-3 border-b bg-card/60 px-5 py-4 sm:px-10">
          <div className="flex min-w-0 flex-1 items-center gap-3 text-[11px] text-muted-foreground">
            <SidebarTrigger />
            <Breadcrumb className="min-w-0">
              <BreadcrumbList className="flex-nowrap gap-3 text-[11px]">
                <BreadcrumbItem className="min-w-0">
                  <span
                    data-feedback-content
                    className="truncate text-secondary-foreground"
                    title={p?.name}
                  >
                    {p?.name ?? 'Projects'}
                  </span>
                </BreadcrumbItem>
                <BreadcrumbSeparator>/</BreadcrumbSeparator>
                <BreadcrumbItem className="shrink-0">
                  <BreadcrumbPage className="text-muted-foreground">
                    {navigation.find((item) => item.id === view)?.label}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          {p ? (
            <Button variant="outline" size="sm" onClick={tryDemo}>
              Open example <ArrowUpRight />
            </Button>
          ) : null}
        </header>
        <div
          data-slot="dashboard-content"
          className="mx-auto w-full max-w-[1280px] px-5 py-8 sm:px-10 sm:py-10"
        >
          {!ready ? (
            <Empty title="Loading…" symbol={<Loader2 className="size-5 animate-spin" />} />
          ) : (
            <DashboardContext.Provider
              value={{
                project: p,
                user,
                saveProject,
                tryDemo,
                refresh,
                feedbackFilter,
                setFeedbackFilter,
                feedbackSearch,
                setFeedbackSearch,
                openNewProject: () => {
                  setNewOpen(true);
                },
              }}
            >
              <Outlet />
            </DashboardContext.Provider>
          )}
        </div>
      </SidebarInset>
      <NewProject
        open={newOpen}
        onOpenChange={setNewOpen}
        demoUrl={demoUrl}
        onCreated={async (next) => {
          setSelected(next.id);
          changeView('install');
          await refresh();
          toast.success('Project created.');
        }}
      />
    </>
  );
}
