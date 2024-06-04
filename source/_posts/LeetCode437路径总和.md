---

layout: LeetCode437路径总和

title:  LeetCode437路径总和

tags: Web

categories: Web

top: 29

path: /article/1784846731

abbrlink: 178484731

date: 2024-02-27 21:03:00


---

# LeetCode437 路径总和

给定一个二叉树的根节点 `root` ，和一个整数 `targetSum` ，求该二叉树里节点值之和等于 `targetSum` 的 **路径** 的数目。

**路径** 不需要从根节点开始，也不需要在叶子节点结束，但是路径方向必须是向下的（只能从父节点到子节点）



<img src="https://gitee.com/fadeway32/fadeway32/raw/master/img/202406042258782.png" alt="image-20240604225850697" style="zoom:120%;"  />

```
输入：root = [10,5,-3,3,2,null,11,3,-2,null,1], targetSum = 8
输出：3
解释：和等于 8 的路径有 3 条，如图所示。
```

**示例 2：**

```
输入：root = [5,4,8,11,null,13,4,7,2,null,null,5,1], targetSum = 22
输出：3
```

我们首先想到的解法是穷举所有的可能，我们访问每一个节点 node\textit{node}node，检测以 node\textit{node}node
为起始节点且向下延深的路径有多少种。我们递归遍历每一个节点的所有可能的路径，然后将这些路径数目加起来即为返回结果。

我们首先定义 rootSum(p,val)\textit{rootSum}(p,\textit{val})rootSum(p,val) 表示以节点 ppp 为起点向下且满足路径总和为
valvalval 的路径数目。我们对二叉树上每个节点 ppp 求出 rootSum(p,targetSum)\textit{rootSum}(p,\textit{targetSum})rootSum(
p,targetSum)，然后对这些路径数目求和即为返回结果。

我们对节点 ppp 求 rootSum(p,targetSum)\textit{rootSum}(p,\textit{targetSum})rootSum(p,targetSum) 时，以当前节点 ppp
为目标路径的起点递归向下进行搜索。假设当前的节点 ppp 的值为 val\textit{val}val，我们对左子树和右子树进行递归搜索，对节点
ppp 的左孩子节点 plp_{l}p
求出 rootSum(pl,targetSum−val)\textit{rootSum}(p_{l},\textit{targetSum}-\textit{val})rootSum(p ,targetSum−val)，以及对右孩子节点
prp_{r}p

求出 rootSum(pr,targetSum−val)\textit{rootSum}(p_{r},\textit{targetSum}-\textit{val})rootSum(p ,targetSum−val)。节点 ppp
的 rootSum(p,targetSum)\textit{rootSum}(p,\textit{targetSum})rootSum(p,targetSum) 即等于 rootSum(pl,targetSum−val)
\textit{rootSum}(p_{l},\textit{targetSum}-\textit{val})rootSum(p ,targetSum−val) 与 rootSum(pr,targetSum−val)
\textit{rootSum}(p_{r},\textit{targetSum}-\textit{val})rootSum(p ,targetSum−val) 之和，同时我们还需要判断一下当前节点 ppp
的值是否刚好等于 targetSum\textit{targetSum}targetSum。

我们采用递归遍历二叉树的每个节点 ppp，对节点 ppp 求 rootSum(p,val)\textit{rootSum}(p,\textit{val})rootSum(p,val)
，然后将每个节点所有求的值进行相加求和返回。

~~~java
class Solution{
    /**
    class ListNode{
    	int val;
    	ListNode next;
    	public ListNode(){}
    	
    	public ListNode(int val){
    		this.val = val;
    	}
    	
    	public ListNode(int val,ListNode node){
    		this.val= val;
    		this.next= node;
    	}
    
    }
    
    **/    
    public int getRet(TreeNode node,long target){
        if(node == null){
            return 0;
        }
        int ret =  getResult(node,target);
        ret += getRet(node.left,target);
        ret += getRet(node.right,target);
        return ret;
    }
    
    public int getResult(TreeNode node,long target){
		int ret = 0;
        if(node == null ){
            return 0;
        }
        
        if(node.val == target){
            ret ++;
        }
        ret += getResult(node.left,target -node.val);
        ret += getResult(node.right,target -node.val);
        
        return ret ;
        
    }
    
    
    
}
~~~

