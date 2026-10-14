import { createContext, useContext } from 'react';
import { Outlet } from 'react-router';
import { Plus } from 'lucide-react';
import { Button } from '../components/ui/button.js';
import { Empty } from '../components/common.js';
import { useDashboard } from './layout.js';
import type { ProjectWithRole } from './models.js';

type ProjectState = Omit<ReturnType<typeof useDashboard>, 'project'> & { project: ProjectWithRole };
const ProjectContext = createContext<ProjectState | null>(null);
export function useProject() {
  const project = useContext(ProjectContext);
  if (!project) throw new Error('This route requires a selected project.');
  return project;
}
export default function ProjectLayout() {
  const { project, ...dashboard } = useDashboard();
  if (!project)
    return (
      <Empty title="No projects" description="Create a project to install the toolbar.">
        <Button onClick={dashboard.openNewProject}>
          <Plus /> Create your first project
        </Button>
      </Empty>
    );
  return (
    <ProjectContext.Provider key={project.id} value={{ ...dashboard, project }}>
      <Outlet />
    </ProjectContext.Provider>
  );
}
