Changes with this fork:

This fork adds two extra command line options:
- -t / --types : treat parameter definitions using custom group names as type definitions
- --ignore-group {name}: ignore group name (case insensitive) as type definition

Both --ignore-group and -i/--input can be specified multiple times

Apidoc does not support custom type definitions. One way to specify them is use an @apiDefine in combination
with @apiParam and a custom group name. The -t/--types option will parse @apiParam (Group) {type} name [description]
as a type definition for an object using type name Group and the parameter as property for the type.

Only the first parameter of a certain name is added, other definitions are ignored.

The fork also checks with type names if there is match with type definitions and uses a $ref to the type if possible.
