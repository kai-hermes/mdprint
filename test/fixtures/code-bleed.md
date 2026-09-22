---
title: Code That Wraps
---

Code blocks must wrap under @media print, not bleed off the page. A long line of
code that hits the right margin is the normal case, not the exception.

```bash
lp -d HP_SmartTank -o sides=two-sided-long-edge -o page-ranges=1-3,7 -- this-argument-is-deliberately-long-enough-to-overflow-the-content-column
```

```python
def a_really_long_function_name_that_nobody_would_ever_actually_write(argument_one, argument_two, argument_three):
    return argument_one + argument_two + argument_three  # plus a trailing comment just to be sure it overflows
```

An inline `identifier_that_is_quite_long_but_should_never_the_less_stay_on_the_line_it_started_on` in a sentence.
