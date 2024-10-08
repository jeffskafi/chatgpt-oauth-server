import { db } from '../index';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { tasks, taskRelationships, type Task, type TaskSelect, NewTask, TaskUpdate, TaskSearchParams } from '../schema';
import { parseDueDate } from '../../utils/Date';

export async function getTopLevelTasks(userId: string): Promise<Task[]> {
  if (!userId) throw new Error('Unauthorized');

  const allTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, userId))
    .orderBy(desc(tasks.createdAt)) // Sort by creation date, newest first
    .execute();

  const relationships = await db
    .select()
    .from(taskRelationships)
    .execute();

  const taskMap = new Map<string, Task>();
  const topLevelTasks: Task[] = [];

  // Create Task objects and store them in the map
  allTasks.forEach(task => {
    taskMap.set(task.id, {
      ...task,
      children: [],
      parentId: null,
    });
  });

  // Establish parent-child relationships
  relationships.forEach(rel => {
    if (rel.parentTaskId !== null) {
      const childTask = taskMap.get(rel.childTaskId);
      const parentTask = taskMap.get(rel.parentTaskId);
      if (childTask && parentTask) {
        childTask.parentId = rel.parentTaskId;
        parentTask.children.push(rel.childTaskId);
      }
    }
  });

  // Collect top-level tasks
  taskMap.forEach(task => {
    if (task.parentId === null) {
      topLevelTasks.push(task);
    }
  });

  return topLevelTasks;
}

export async function createTask(newTask: NewTask, userId: string): Promise<Task> {
  if (!userId) throw new Error('Unauthorized');

  if (newTask.userId !== userId) throw new Error('Unauthorized: User ID mismatch');

  try {
    const formattedTask = {
      ...newTask,
      dueDate: parseDueDate(newTask.dueDate),
    };

    const [insertedTask] = await db.insert(tasks).values(formattedTask).returning();

    if (!insertedTask) {
      throw new Error('Failed to insert task');
    }

    if (newTask.parentId) {
      const result = await db.insert(taskRelationships).values({
        parentTaskId: newTask.parentId,
        childTaskId: insertedTask.id,
      });

      if (!result) {
        throw new Error('Failed to create task relationship');
      }
    }

    return {
      ...insertedTask,
      parentId: newTask.parentId ?? null,
      children: [],
    };
  } catch (error) {
    console.error('Error creating task:', error);
    throw new Error('Failed to create task');
  }
}

export async function updateTask(id: TaskSelect['id'], updates: TaskUpdate, userId: string): Promise<Task> {
  if (!userId) throw new Error('Unauthorized');

  return await db.transaction(async (tx) => {
    const formattedUpdates = {
      ...updates,
      dueDate: updates.dueDate ? parseDueDate(updates.dueDate) : undefined,
    };

    const [updatedTask] = await tx
      .update(tasks)
      .set(formattedUpdates)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
      .returning();

    if (!updatedTask) throw new Error('Task not found, not owned by user, or failed to update');

    // Get both child and parent relationships in one query
    const relationships = await tx
      .select()
      .from(taskRelationships)
      .where(or(
        eq(taskRelationships.parentTaskId, id),
        eq(taskRelationships.childTaskId, id)
      ));

    const parentId = relationships.find(r => r.childTaskId === id)?.parentTaskId ?? null;

    return {
      ...updatedTask,
      parentId,
      children: relationships.filter(r => r.parentTaskId === id).map(r => r.childTaskId),
    };
  });
}

export async function deleteTask(id: TaskSelect['id'], userId: string): Promise<void> {
  if (!userId) throw new Error('Unauthorized');

  return await db.transaction(async (tx) => {
    // Function to recursively delete tasks and their children
    async function deleteTaskAndChildren(taskId: TaskSelect['id']): Promise<void> {
      // Get child tasks
      const childRelations = await tx
        .select()
        .from(taskRelationships)
        .where(eq(taskRelationships.parentTaskId, taskId));

      // Recursively delete child tasks
      for (const relation of childRelations) {
        await deleteTaskAndChildren(relation.childTaskId);
      }

      // Delete relationships for this task
      await tx
        .delete(taskRelationships)
        .where(or(
          eq(taskRelationships.parentTaskId, taskId),
          eq(taskRelationships.childTaskId, taskId)
        ));

      // Delete the task itself
      await tx
        .delete(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
    }

    // Start the recursive deletion from the top-level task
    await deleteTaskAndChildren(id);
  });
}

export async function moveTask(taskId: TaskSelect['id'], newParentId: TaskSelect['id'] | null, userId: string): Promise<void> {
  if (!userId) throw new Error('Unauthorized');

  await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));

    if (!task) throw new Error('Task not found');

    await tx
      .delete(taskRelationships)
      .where(eq(taskRelationships.childTaskId, taskId));

    if (newParentId !== null) {
      const [newParent] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, newParentId), eq(tasks.userId, userId)));

      if (!newParent) throw new Error('New parent task not found');

      await tx.insert(taskRelationships).values({
        parentTaskId: newParentId,
        childTaskId: taskId,
      });
    }
  });
}

export async function searchTasks(params: TaskSearchParams, userId: string): Promise<Task[]> {
  if (!userId) throw new Error('Unauthorized');

  const searchResults = await db.select()
    .from(tasks)
    .where(and(
      eq(tasks.userId, userId),
      params.query ? ilike(tasks.description, `%${params.query}%`) : undefined,
      params.status ? eq(tasks.status, params.status) : undefined,
      params.priority ? eq(tasks.priority, params.priority) : undefined,
      params.completed !== undefined ? eq(tasks.completed, params.completed) : undefined,
      params.dueDate ? eq(tasks.dueDate, params.dueDate) : undefined
    ))
    .execute();

  // Fetch relationships for the found tasks
  const taskIds = searchResults.map(task => task.id);
  const relationships = await db
    .select()
    .from(taskRelationships)
    .where(or(
      inArray(taskRelationships.parentTaskId, taskIds),
      inArray(taskRelationships.childTaskId, taskIds)
    ))
    .execute();

  // Map the results to include parentId and children
  return searchResults.map(task => ({
    ...task,
    parentId: relationships.find(r => r.childTaskId === task.id)?.parentTaskId ?? null,
    children: relationships
      .filter(r => r.parentTaskId === task.id)
      .map(r => r.childTaskId),
  }));
}

export async function getSubtasks(taskId: TaskSelect['id'], userId: string): Promise<Task[]> {
  if (!userId) throw new Error('Unauthorized');

  // Fetch subtasks
  const subtasks = await db
    .select()
    .from(tasks)
    .innerJoin(
      taskRelationships,
      eq(taskRelationships.childTaskId, tasks.id)
    )
    .where(eq(taskRelationships.parentTaskId, taskId))

  // Fetch child relationships for all subtasks in one query
  const childRelationships = await db
    .select()
    .from(taskRelationships)
    .where(inArray(taskRelationships.parentTaskId, subtasks.map(t => t.tasks.id)));

  // Map subtasks to Task type
  return subtasks.map(subtask => ({
    ...subtask.tasks,
    parentId: taskId,
    children: childRelationships
      .filter(r => r.parentTaskId === subtask.tasks.id)
      .map(r => r.childTaskId),
  }));
}