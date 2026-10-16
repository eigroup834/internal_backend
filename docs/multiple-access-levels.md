# Multiple access levels

Apply `sql/user_access_levels.sql` to the application database before deploying the backend. It adds a nullable VARCHAR(50) ACCESS_LEVELS column to dbo.[USER]. The existing ACCESS_LEVEL column remains the primary/default role; old accounts with a null ACCESS_LEVELS keep their current access.

In Editor Management, add or edit a user and check one or more access roles. The stored list is comma separated (for example, 3,6); JWTs expose it as access_levels: [3,6]. A route is allowed when any assigned role is in its existing allowed list. No level implicitly grants every numerically higher level. Editor permissions take precedence over viewer restrictions when both are assigned.

Only administrators can grant Administrator access or update an administrator account. Administrators and managers can add/edit other user roles. Existing tokens retain their roles until they expire; sign out and sign in after changing roles. The first selected role determines the default landing page, with Administrator taking precedence.

Visitor membership queries include users whose additional roles include 5 or 6. Existing route-level policies otherwise remain in effect.

Validation: frontend accessLevels.test.js; backend `node --test utils/accessLevels.test.js`; frontend `npm run build`. Database migration and live login/assignment flows require validation against the application database after migration.
