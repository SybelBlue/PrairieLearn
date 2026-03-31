import stripAnsi from 'strip-ansi';
import { afterAll, assert, beforeAll, describe, test } from 'vitest';

import { execute, queryRow } from '@prairielearn/postgres';
import { generatePrefixCsrfToken } from '@prairielearn/signed-token';

import { config } from '../../lib/config.js';
import { EnrollmentSchema } from '../../lib/db-types.js';
import { EXAMPLE_COURSE_PATH } from '../../lib/paths.js';
import { getJobSequence } from '../../lib/server-jobs.js';
import {
  insertCourseInstancePermissions,
  insertCoursePermissionsByUserUid,
} from '../../models/course-permissions.js';
import * as helperCourse from '../../tests/helperCourse.js';
import * as helperServer from '../../tests/helperServer.js';
import { type AuthUser, getOrCreateUser, withUser } from '../../tests/utils/auth.js';
import { createCourseInstanceTrpcClient } from '../../trpc/courseInstance/client.js';

const siteUrl = `http://localhost:${config.serverPort}`;

const instructorUser: AuthUser = {
  uid: 'instructor@example.com',
  name: 'Test Instructor',
  uin: 'instructor1',
  email: 'instructor@example.com',
};

describe('Instructor Students - Invite by UID', () => {
  let trpcClient: ReturnType<typeof createCourseInstanceTrpcClient>;

  beforeAll(helperServer.before());

  afterAll(helperServer.after);

  beforeAll(async () => {
    await helperCourse.syncCourse(EXAMPLE_COURSE_PATH);

    await execute("UPDATE institutions SET uid_regexp = '@example\\.com$' WHERE id = 1");

    // Enable modern publishing so the tRPC inviteStudents mutation works.
    await execute('UPDATE course_instances SET modern_publishing = true WHERE id = 1');

    const dbUser = await getOrCreateUser(instructorUser);

    await insertCoursePermissionsByUserUid({
      course_id: '1',
      uid: 'instructor@example.com',
      course_role: 'Owner',
      authn_user_id: '1',
    });

    await insertCourseInstancePermissions({
      course_id: '1',
      course_instance_id: '1',
      user_id: dbUser.id,
      course_instance_role: 'Student Data Editor',
      authn_user_id: '1',
    });

    const csrfToken = generatePrefixCsrfToken(
      { url: '/pl/course_instance/1/instructor/trpc', authn_user_id: dbUser.id },
      config.secretKey,
    );
    trpcClient = createCourseInstanceTrpcClient({
      csrfToken,
      courseInstanceId: '1',
      urlBase: siteUrl,
    });
  });

  test.sequential('should successfully invite a nonexistent user', async () => {
    const result = await withUser(instructorUser, () =>
      trpcClient.students.inviteStudents.mutate({ uids: ['nonexistent@example.com'] }),
    );
    assert.isString(result.jobSequenceId);

    await helperServer.waitForJobSequenceSuccess(result.jobSequenceId);

    const jobSequence = await getJobSequence(result.jobSequenceId, '1');
    assert.equal(jobSequence.status, 'Success');
    assert.lengthOf(jobSequence.jobs, 1);

    const job = jobSequence.jobs[0];
    const output = stripAnsi(job.output ?? '');
    assert.equal(
      output,
      `nonexistent@example.com: Invited
\nSummary:
  Successfully invited: 1\n`,
    );
  });

  test.sequential('should skip when user is an instructor', async () => {
    await getOrCreateUser({
      uid: 'another_instructor@example.com',
      name: 'Another Instructor',
      uin: 'instructor2',
      email: 'another_instructor@example.com',
    });

    await insertCoursePermissionsByUserUid({
      course_id: '1',
      uid: 'another_instructor@example.com',
      course_role: 'Viewer',
      authn_user_id: '1',
    });

    const result = await withUser(instructorUser, () =>
      trpcClient.students.inviteStudents.mutate({ uids: ['another_instructor@example.com'] }),
    );
    assert.isString(result.jobSequenceId);

    await helperServer.waitForJobSequenceSuccess(result.jobSequenceId);

    const jobSequence = await getJobSequence(result.jobSequenceId, '1');
    assert.equal(jobSequence.status, 'Success');

    const job = jobSequence.jobs[0];
    const output = stripAnsi(job.output ?? '');
    assert.equal(
      output,
      `another_instructor@example.com: Skipped (instructor)
\nSummary:
  Successfully invited: 0
  Skipped (instructor): 1\n`,
    );
  });

  test.sequential('should skip when trying to invite a blocked user', async () => {
    const blockedStudent = await getOrCreateUser({
      uid: 'blocked_student@example.com',
      name: 'Blocked Student',
      uin: 'blocked1',
      email: 'blocked_student@example.com',
    });

    await queryRow(
      `INSERT INTO enrollments (user_id, course_instance_id, status, first_joined_at)
       VALUES ($user_id, $course_instance_id, 'blocked', NOW())
       RETURNING *`,
      {
        user_id: blockedStudent.id,
        course_instance_id: '1',
      },
      EnrollmentSchema,
    );

    const result = await withUser(instructorUser, () =>
      trpcClient.students.inviteStudents.mutate({ uids: ['blocked_student@example.com'] }),
    );
    assert.isString(result.jobSequenceId);

    await helperServer.waitForJobSequenceSuccess(result.jobSequenceId);

    const jobSequence = await getJobSequence(result.jobSequenceId, '1');
    assert.equal(jobSequence.status, 'Success');

    const job = jobSequence.jobs[0];
    const output = stripAnsi(job.output ?? '');
    assert.equal(
      output,
      `blocked_student@example.com: Skipped (blocked)
\nSummary:
  Successfully invited: 0
  Skipped (blocked): 1\n`,
    );
  });

  test.sequential('should successfully invite a new student', async () => {
    await getOrCreateUser({
      uid: 'new_student@example.com',
      name: 'New Student',
      uin: 'new1',
      email: 'new_student@example.com',
    });

    const result = await withUser(instructorUser, () =>
      trpcClient.students.inviteStudents.mutate({ uids: ['new_student@example.com'] }),
    );
    assert.isString(result.jobSequenceId);

    await helperServer.waitForJobSequenceSuccess(result.jobSequenceId);

    const jobSequence = await getJobSequence(result.jobSequenceId, '1');
    assert.equal(jobSequence.status, 'Success');

    const job = jobSequence.jobs[0];
    const output = stripAnsi(job.output ?? '');
    assert.equal(
      output,
      `new_student@example.com: Invited
\nSummary:
  Successfully invited: 1\n`,
    );
  });

  test.sequential('should successfully invite multiple students', async () => {
    await getOrCreateUser({
      uid: 'bulk_student1@example.com',
      name: 'Bulk Student 1',
      uin: 'bulk1',
      email: 'bulk_student1@example.com',
    });

    await getOrCreateUser({
      uid: 'bulk_student2@example.com',
      name: 'Bulk Student 2',
      uin: 'bulk2',
      email: 'bulk_student2@example.com',
    });

    const result = await withUser(instructorUser, () =>
      trpcClient.students.inviteStudents.mutate({
        uids: ['bulk_student1@example.com', 'bulk_student2@example.com'],
      }),
    );
    assert.isString(result.jobSequenceId);

    await helperServer.waitForJobSequenceSuccess(result.jobSequenceId);

    const jobSequence = await getJobSequence(result.jobSequenceId, '1');
    assert.equal(jobSequence.status, 'Success');

    const job = jobSequence.jobs[0];
    const output = stripAnsi(job.output ?? '');
    assert.equal(
      output,
      `bulk_student1@example.com: Invited
bulk_student2@example.com: Invited
\nSummary:
  Successfully invited: 2\n`,
    );
  });
});
