import { describe, expect, it } from 'vitest'
import { decideToolAccess, defaultAccessPolicy, sharedTokenPolicy } from '../src/hosted/policy.js'

describe('hosted Targetprocess tool access policy', () => {
  it('limits service-token users to reads and attributed comments', () => {
    expect(decideToolAccess('shared', sharedTokenPolicy, 'get_opportunities')).toMatchObject({ allowed: true, category: 'read' })
    expect(decideToolAccess('shared', sharedTokenPolicy, 'add_comment')).toMatchObject({ allowed: true, category: 'comment' })
    expect(decideToolAccess('shared', sharedTokenPolicy, 'add_comment_with_user')).toMatchObject({ allowed: false, category: 'comment' })
    expect(decideToolAccess('shared', sharedTokenPolicy, 'create_user_story')).toMatchObject({ allowed: false, category: 'create' })
    expect(decideToolAccess('shared', sharedTokenPolicy, 'delete_internal_card')).toMatchObject({ allowed: false, category: 'delete' })
  })

  it('keeps destructive tools disabled by default for personal-token users', () => {
    expect(decideToolAccess('personal', defaultAccessPolicy, 'get_opportunities')).toMatchObject({ allowed: true, category: 'read' })
    expect(decideToolAccess('personal', defaultAccessPolicy, 'create_user_story')).toMatchObject({ allowed: true, category: 'create' })
    expect(decideToolAccess('personal', defaultAccessPolicy, 'delete_internal_card')).toMatchObject({ allowed: false, category: 'delete' })
    expect(decideToolAccess('personal', defaultAccessPolicy, 'delete_card_relation')).toMatchObject({ allowed: false, category: 'delete' })
  })
})
